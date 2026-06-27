// WebSocket 接收处理：升级连接 → 校验 token → 接收客户端上报 → 写库（含降频控频）

import {
  upsertDevice,
  getLastHistoryAt,
  setLastHistoryAt,
  insertHistory,
  type Report,
} from "./db";
import { checkDeviceToken } from "./auth";
import { shouldRunCleanup, maybeCleanup } from "./cleanup";
import type { Env } from "./env";

const MIN_LATEST_INTERVAL = 2; // 实时表 UPSERT 最小间隔（秒），低于则跳过
const HISTORY_INTERVAL = 15; // 历史采样间隔（秒）

// 记录每条连接最近一次写库的时间（内存中），实现发送侧之外的额外节流
const lastWriteMap = new Map<string, number>();

export async function handleWs(request: Request, env: Env): Promise<Response> {
  // 校验 token（URL 查询参数 ?token=...）
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!checkDeviceToken(env, token)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") {
    return new Response("Expected Upgrade: websocket", { status: 426 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();

  server.addEventListener("message", async (event) => {
    try {
      const report = JSON.parse(event.data as string) as Report;
      if (!report.device_id) return;
      await processReport(server, env, report, request);
    } catch (e) {
      // 解析失败不关闭连接，避免恶意/异常数据中断采集
      console.error("ws message error", e);
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function processReport(
  _server: WebSocket,
  env: Env,
  report: Report,
  request: Request,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const id = report.device_id;

  // 实时表节流：距离上次写库 < 2s 则跳过（保护 D1 免费额度）
  const last = lastWriteMap.get(id) ?? 0;
  if (now - last < MIN_LATEST_INTERVAL) {
    return;
  }
  lastWriteMap.set(id, now);

  // 公网 IP 由服务端从 Cloudflare 头填入（客户端无需外网请求）
  const ipPublic =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    "";

  await upsertDevice(env.DB, report, ipPublic);

  // 历史采样控频：每 ~15s 才插一条
  const lastHist = await getLastHistoryAt(env.DB, id);
  if (lastHist === null || now - lastHist >= HISTORY_INTERVAL) {
    const cpu = report.cpu_percent ?? 0;
    const mem = report.memory_percent ?? 0;
    const diskPercent = aggregateDiskPercent(report);
    const { netRx, netTx } = aggregateNet(report);
    await insertHistory(env.DB, id, now, cpu, mem, diskPercent, netRx, netTx);
    await setLastHistoryAt(env.DB, id, now);
  }

  // 懒清理历史
  if (shouldRunCleanup()) {
    const days = Number(env.HISTORY_DAYS ?? 7);
    await maybeCleanup(env.DB, days);
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
