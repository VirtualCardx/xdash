// HTTP API：登录、设备列表、设备详情、历史趋势。
// 所有 /api/*（除 /api/login）都需校验会话 token。

import { listDevices, getDevice, getHistory, type DeviceRow } from "./db";
import { checkWebPassword, issueSessionToken, verifySessionToken, extractBearer } from "./auth";
import type { Env } from "./env";

const ONLINE_THRESHOLD = 15; // 15s 内有上报视为在线

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// 校验请求中的会话 token
async function requireAuth(request: Request, env: Env): Promise<boolean> {
  const token = extractBearer(request.headers.get("Authorization"));
  if (!token) return false;
  return verifySessionToken(env, token);
}

// 把原始 DeviceRow 转成前端友好结构（解析 JSON 字段 + 计算在线状态）
function shapeDevice(row: DeviceRow) {
  return {
    device_id: row.device_id,
    hostname: row.hostname,
    os_name: row.os_name,
    os_version: row.os_version,
    kernel: row.kernel,
    arch: row.arch,
    uptime_seconds: row.uptime_seconds,
    cpu_model: row.cpu_model,
    cpu_cores: row.cpu_cores,
    total_memory: row.total_memory,
    ip_local: row.ip_local,
    ip_public: row.ip_public,
    cpu_percent: row.cpu_percent,
    memory_percent: row.memory_percent,
    cpu_top: safeParse(row.cpu_top),
    memory_top: safeParse(row.memory_top),
    disk: safeParse(row.disk),
    network: safeParse(row.network),
    last_seen: row.last_seen,
    online: isOnline(row.last_seen),
  };
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isOnline(lastSeen: number | null): boolean {
  if (!lastSeen) return false;
  return Math.floor(Date.now() / 1000) - lastSeen < ONLINE_THRESHOLD;
}

export async function handleApi(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const method = request.method;

  // POST /api/login —— 校验网页密码，派发会话 token
  if (path === "/api/login" && method === "POST") {
    const body = await request
      .json<{ password?: string }>()
      .catch(() => ({}) as { password?: string });
    if (!body.password || !checkWebPassword(env, body.password)) {
      return json({ ok: false, error: "密码错误" }, 401);
    }
    const token = await issueSessionToken(env);
    return json({ ok: true, token });
  }

  // 以下接口都需要登录
  if (!(await requireAuth(request, env))) {
    return json({ ok: false, error: "未授权" }, 401);
  }

  // GET /api/devices —— 设备列表
  if (path === "/api/devices" && method === "GET") {
    const rows = await listDevices(env.DB);
    return json({ ok: true, devices: rows.map(shapeDevice) });
  }

  // GET /api/devices/:id —— 单设备实时详情
  const detailMatch = /^\/api\/devices\/([^/]+)$/.exec(path);
  if (detailMatch && method === "GET") {
    const row = await getDevice(env.DB, decodeURIComponent(detailMatch[1]));
    if (!row) return json({ ok: false, error: "设备不存在" }, 404);
    return json({ ok: true, device: shapeDevice(row) });
  }

  // GET /api/devices/:id/history?range=1h|6h|24h —— 历史趋势
  const histMatch = /^\/api\/devices\/([^/]+)\/history$/.exec(path);
  if (histMatch && method === "GET") {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") ?? "1h";
    const hours = rangeToHours(range);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const points = await getHistory(env.DB, decodeURIComponent(histMatch[1]), since);
    return json({ ok: true, range, points });
  }

  return json({ ok: false, error: "Not Found" }, 404);
}

function rangeToHours(range: string): number {
  switch (range) {
    case "1h":
      return 1;
    case "6h":
      return 6;
    case "24h":
      return 24;
    default:
      return 1;
  }
}
