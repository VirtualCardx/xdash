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
  type ProcItem,
  type DiskItem,
  type NetItem,
} from "./db.js";
import { checkDeviceToken } from "./auth.js";
import { shouldRunCleanup, maybeCleanup } from "./cleanup.js";
import { config } from "./config.js";

const MIN_LATEST_INTERVAL = 2; // 实时表 UPSERT 最小间隔（秒）
const HISTORY_INTERVAL = 15; // 历史采样间隔（秒）
const MAX_WS_PAYLOAD = 256 * 1024;
const MAX_DEVICE_ID = 128;
const MAX_TEXT = 256;
const MAX_PROC_ITEMS = 20;
const MAX_DISK_ITEMS = 64;
const MAX_NET_ITEMS = 64;
const LAST_WRITE_TTL = 24 * 3600;
const LAST_WRITE_CLEANUP_INTERVAL = 3600;

// 记录每个设备最近一次写库的时间，实现发送侧之外的额外节流
const lastWriteMap = new Map<string, number>();
let lastWriteCleanupAt = 0;

// 从 IncomingMessage 取公网 IP。只有显式信任反向代理时才读取转发头。
function getClientIp(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined,
): string {
  if (config.trustProxy) {
    const xff = headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
    const xri = headers["x-real-ip"];
    if (typeof xri === "string" && xri) return xri;
  }
  return remoteAddress?.replace(/^::ffff:/, "") ?? "";
}

// 把 ws 服务挂到 HTTP server 上，拦截 /ws 的 upgrade 请求
export function attachWs(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

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
    const ip = getClientIp(
      req.headers as Record<string, string | string[]>,
      req.socket.remoteAddress,
    );

    ws.on("message", (raw) => {
      try {
        const report = normalizeReport(JSON.parse(raw.toString()));
        if (!report) return;
        processReport(report, ip);
      } catch (e) {
        // 解析失败不关闭连接，避免异常数据中断采集
        console.error("[ws] message error", e);
      }
    });
  });

  return wss;
}

function normalizeReport(input: unknown): Report | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const deviceId = cleanText(r.device_id, MAX_DEVICE_ID);
  if (!deviceId) return null;

  return {
    device_id: deviceId,
    hostname: cleanText(r.hostname, MAX_TEXT),
    os_name: cleanText(r.os_name, MAX_TEXT),
    os_version: cleanText(r.os_version, MAX_TEXT),
    kernel: cleanText(r.kernel, MAX_TEXT),
    arch: cleanText(r.arch, MAX_TEXT),
    uptime_seconds: cleanInteger(r.uptime_seconds, 0, Number.MAX_SAFE_INTEGER),
    cpu_model: cleanText(r.cpu_model, MAX_TEXT),
    cpu_cores: cleanInteger(r.cpu_cores, 0, 4096),
    total_memory: cleanInteger(r.total_memory, 0, Number.MAX_SAFE_INTEGER),
    available_memory: cleanInteger(r.available_memory, 0, Number.MAX_SAFE_INTEGER),
    ip_local: cleanText(r.ip_local, MAX_TEXT),
    cpu_percent: cleanNumber(r.cpu_percent, 0, 10000),
    memory_percent: cleanNumber(r.memory_percent, 0, 100),
    cpu_top: cleanProcItems(r.cpu_top, "cpu"),
    memory_top: cleanProcItems(r.memory_top, "mem"),
    disk: cleanDiskItems(r.disk),
    network: cleanNetItems(r.network),
  };
}

function cleanText(value: unknown, maxLen: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s) return undefined;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function cleanNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function cleanInteger(value: unknown, min: number, max: number): number | undefined {
  const n = cleanNumber(value, min, max);
  return n === undefined ? undefined : Math.trunc(n);
}

function cleanProcItems(value: unknown, field: "cpu" | "mem"): ProcItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: ProcItem[] = [];
  for (const raw of value.slice(0, MAX_PROC_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = cleanText(item.name, MAX_TEXT);
    if (!name) continue;
    items.push({
      name,
      cpu: field === "cpu" ? cleanNumber(item.cpu, 0, 10000) : undefined,
      mem: field === "mem" ? cleanInteger(item.mem, 0, Number.MAX_SAFE_INTEGER) : undefined,
    });
  }
  return items;
}

function cleanDiskItems(value: unknown): DiskItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: DiskItem[] = [];
  for (const raw of value.slice(0, MAX_DISK_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const mount = cleanText(item.mount, MAX_TEXT);
    const used = cleanInteger(item.used, 0, Number.MAX_SAFE_INTEGER);
    const total = cleanInteger(item.total, 0, Number.MAX_SAFE_INTEGER);
    const percent = cleanNumber(item.percent, 0, 100);
    if (!mount || used === undefined || total === undefined || percent === undefined) continue;
    items.push({ mount, used, total, percent });
  }
  return items;
}

function cleanNetItems(value: unknown): NetItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: NetItem[] = [];
  for (const raw of value.slice(0, MAX_NET_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = cleanText(item.name, MAX_TEXT);
    const rxRate = cleanNumber(item.rx_rate, 0, Number.MAX_SAFE_INTEGER);
    const txRate = cleanNumber(item.tx_rate, 0, Number.MAX_SAFE_INTEGER);
    if (!name || rxRate === undefined || txRate === undefined) continue;
    items.push({ name, rx_rate: rxRate, tx_rate: txRate });
  }
  return items;
}

function processReport(report: Report, ipPublic: string): void {
  const now = Math.floor(Date.now() / 1000);
  const id = report.device_id;
  cleanupLastWriteMap(now);

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

function cleanupLastWriteMap(now: number): void {
  if (now - lastWriteCleanupAt < LAST_WRITE_CLEANUP_INTERVAL) return;
  lastWriteCleanupAt = now;
  for (const [deviceId, ts] of lastWriteMap) {
    if (now - ts > LAST_WRITE_TTL) {
      lastWriteMap.delete(deviceId);
    }
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

// 删除设备后调用：从内存节流映射中移除对应记录，避免幽灵条目残留。
// 由 api.ts 的删除端点在成功删库后调用。
export function forgetDevices(ids: string[]): void {
  for (const id of ids) {
    lastWriteMap.delete(id);
  }
}

// 标记 ws 在编译期被引用，避免未使用类型导入告警（WebSocket 用于未来扩展广播）
export type { WebSocket };
