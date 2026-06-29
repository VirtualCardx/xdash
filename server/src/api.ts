// HTTP API（Express Router）：登录、设备列表、设备详情、历史趋势。
// 所有 /api/*（除 /api/login）都需校验会话 token。

import { Router, type Request, type Response, type NextFunction } from "express";
import { listDevices, getDevice, getHistory, type DeviceRow } from "./db.js";
import {
  checkWebPassword,
  issueSessionToken,
  verifySessionToken,
  extractBearer,
} from "./auth.js";

const ONLINE_THRESHOLD = 15; // 15s 内有上报视为在线

export const apiRouter = Router();

// 登录不要求认证
apiRouter.post("/login", (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password || !checkWebPassword(password)) {
    res.status(401).json({ ok: false, error: "密码错误" });
    return;
  }
  const token = issueSessionToken();
  res.json({ ok: true, token });
});

// 以下接口都需要登录
apiRouter.use(requireAuth);

// 设备列表
apiRouter.get("/devices", (_req: Request, res: Response) => {
  const rows = listDevices();
  res.json({ ok: true, devices: rows.map(shapeDevice) });
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
  const range = (req.query.range as string) ?? "1h";
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
