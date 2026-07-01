// HTTP API（Express Router）：登录、设备列表、设备详情、历史趋势。
// 所有 /api/*（除 /api/login）都需校验会话 token。

import { Router, type Request, type Response, type NextFunction } from "express";
import {
  getDb,
  listDevices,
  getDevice,
  getHistory,
  type DeviceRow,
  type DeviceSummaryRow,
} from "./db.js";
import {
  checkWebPassword,
  issueSessionToken,
  verifySessionToken,
  extractBearer,
} from "./auth.js";

const ONLINE_THRESHOLD = 15; // 15s 内有上报视为在线
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const apiRouter = Router();

interface LoginAttempt {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const loginAttempts = new Map<string, LoginAttempt>();
let lastLoginCleanupAt = 0;

// 登录不要求认证
apiRouter.post("/login", (req: Request, res: Response) => {
  cleanupLoginAttempts();
  const key = loginKey(req);
  if (isLoginBlocked(key)) {
    res.status(429).json({ ok: false, error: "尝试次数过多，请稍后再试" });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password || !checkWebPassword(password)) {
    recordLoginFailure(key);
    res.status(401).json({ ok: false, error: "密码错误" });
    return;
  }
  clearLoginFailures(key);
  const token = issueSessionToken();
  res.json({ ok: true, token });
});

// 健康检查不要求认证，便于 systemd/nginx/外部监控探活
apiRouter.get("/health", (_req: Request, res: Response) => {
  try {
    getDb().prepare("SELECT 1").get();
    res.json({ ok: true, status: "ok", ts: Math.floor(Date.now() / 1000) });
  } catch {
    res.status(503).json({ ok: false, status: "error" });
  }
});

// 以下接口都需要登录
apiRouter.use(requireAuth);

// 设备列表
apiRouter.get("/devices", (_req: Request, res: Response) => {
  const rows = listDevices();
  res.json({ ok: true, devices: rows.map(shapeDeviceSummary) });
});

// 单设备实时详情
apiRouter.get("/devices/:id", (req: Request, res: Response) => {
  const row = getDevice(decodeURIComponent(req.params.id));
  if (!row) {
    res.status(404).json({ ok: false, error: "设备不存在" });
    return;
  }
  res.json({ ok: true, device: shapeDevice(row) });
});

// 历史趋势
apiRouter.get("/devices/:id/history", (req: Request, res: Response) => {
  const range = normalizeRange(req.query.range);
  const hours = rangeToHours(range);
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const points = getHistory(decodeURIComponent(req.params.id), since);
  res.json({ ok: true, range, points });
});

// ---------- 中间件/工具 ----------
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearer(req.header("Authorization"));
  if (!token || !verifySessionToken(token)) {
    res.status(401).json({ ok: false, error: "未授权" });
    return;
  }
  next();
}

function loginKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isLoginBlocked(key: string): boolean {
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  if (attempt.blockedUntil > Date.now()) return true;
  if (attempt.blockedUntil > 0) {
    loginAttempts.delete(key);
  }
  return false;
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const current = loginAttempts.get(key);
  const attempt =
    current && now - current.firstFailureAt < LOGIN_WINDOW_MS
      ? current
      : { failures: 0, firstFailureAt: now, blockedUntil: 0 };

  attempt.failures += 1;
  if (attempt.failures >= LOGIN_MAX_FAILURES) {
    attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  }
  loginAttempts.set(key, attempt);
}

function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

function cleanupLoginAttempts(): void {
  const now = Date.now();
  if (now - lastLoginCleanupAt < LOGIN_CLEANUP_INTERVAL_MS) return;
  lastLoginCleanupAt = now;
  for (const [key, attempt] of loginAttempts) {
    const windowExpired = now - attempt.firstFailureAt >= LOGIN_WINDOW_MS;
    const blockExpired = attempt.blockedUntil > 0 && attempt.blockedUntil <= now;
    if (windowExpired || blockExpired) {
      loginAttempts.delete(key);
    }
  }
}

function isOnline(lastSeen: number | null): boolean {
  if (!lastSeen) return false;
  return Math.floor(Date.now() / 1000) - lastSeen < ONLINE_THRESHOLD;
}

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function shapeDeviceSummary(row: DeviceSummaryRow) {
  return {
    device_id: row.device_id,
    hostname: row.hostname,
    os_name: row.os_name,
    os_version: row.os_version,
    ip_public: row.ip_public,
    cpu_percent: row.cpu_percent,
    memory_percent: row.memory_percent,
    last_seen: row.last_seen,
    online: isOnline(row.last_seen),
  };
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
    available_memory: row.available_memory,
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

function normalizeRange(range: unknown): "1h" | "6h" | "24h" {
  return range === "6h" || range === "24h" ? range : "1h";
}

function rangeToHours(range: "1h" | "6h" | "24h"): number {
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
