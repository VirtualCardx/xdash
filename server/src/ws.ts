// WebSocket 接收处理：用 ws 库的 noServer 模式，
// 在 HTTP upgrade 阶段校验 token，然后处理客户端上报（含降频控频）。

import type { Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  upsertDevice,
  getLastHistoryAt,
  setLastHistoryAt,
  insertHistory,
  type Report,
} from "./db.js";
import { checkDeviceToken } from "./auth.js";
import { shouldRunCleanup, maybeCleanup } from "./cleanup.js";

const MIN_LATEST_INTERVAL = 2; // 实时表 UPSERT 最小间隔（秒）
const HISTORY_INTERVAL = 15; // 历史采样间隔（秒）

// 记录每个设备最近一次写库的时间，实现发送侧之外的额外节流
const lastWriteMap = new Map<string, number>();

// 从 IncomingMessage 取真实公网 IP
function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  const xri = headers["x-real-ip"];
  if (typeof xri === "string" && xri) return xri;
  return "";
}

// 把 ws 服务挂到 HTTP server 上，拦截 /ws 的 upgrade 请求
export function attachWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket: Socket, head) => {
    // 仅处理 /ws 路径
    const path = req.url?.split("?")[0];
    if (path !== "/ws") {
      socket.destroy();
      return;
    }

    // 校验 token（URL 查询参数 ?token=...）
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
    if (!checkDeviceToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const ip = getClientIp(req.headers as Record<string, string | string[]>);

    ws.on("message", (raw) => {
      try {
        const report = JSON.parse(raw.toString()) as Report;
        if (!report.device_id) return;
        processReport(report, ip);
      } catch (e) {
        // 解析失败不关闭连接，避免异常数据中断采集
        console.error("[ws] message error", e);
      }
    });
  });

  return wss;
}

function processReport(report: Report, ipPublic: string): void {
  const now = Math.floor(Date.now() / 1000);
  const id = report.device_id;

  // 实时表节流：距离上次写库 < 2s 则跳过（保护写入频率）
  const last = lastWriteMap.get(id) ?? 0;
  if (now - last < MIN_LATEST_INTERVAL) return;
  lastWriteMap.set(id, now);

  upsertDevice(report, ipPublic);

  // 历史采样控频：每 ~15s 才插一条
  const lastHist = getLastHistoryAt(id);
  if (lastHist === null || now - lastHist >= HISTORY_INTERVAL) {
    const cpu = report.cpu_percent ?? 0;
    const mem = report.memory_percent ?? 0;
    const diskPercent = aggregateDiskPercent(report);
    const { netRx, netTx } = aggregateNet(report);
    insertHistory(id, now, cpu, mem, diskPercent, netRx, netTx);
    setLastHistoryAt(id, now);
  }

  // 懒清理历史
  if (shouldRunCleanup()) {
    maybeCleanup();
  }
}

// 磁盘：取占用率最高的挂载点作为代表值（用于历史曲线）
function aggregateDiskPercent(report: Report): number {
  if (!report.disk?.length) return 0;
  return report.disk.reduce((m, d) => Math.max(m, d.percent ?? 0), 0);
}

// 网络：汇总所有网卡速率
function aggregateNet(report: Report): { netRx: number; netTx: number } {
  if (!report.network?.length) return { netRx: 0, netTx: 0 };
  return report.network.reduce(
    (acc, n) => ({
      netRx: acc.netRx + (n.rx_rate ?? 0),
      netTx: acc.netTx + (n.tx_rate ?? 0),
    }),
    { netRx: 0, netTx: 0 },
  );
}

// 标记 ws 在编译期被引用，避免未使用类型导入告警（WebSocket 用于未来扩展广播）
export type { WebSocket };
