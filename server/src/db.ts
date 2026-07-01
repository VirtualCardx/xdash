// 数据访问层：better-sqlite3（同步 API）。
// 替代原 Cloudflare D1。SQL 语句与字段语义保持一致。
// 启动时自动建表，无需手动执行 schema.sql。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

// ---------- 报文结构（与 Rust 客户端 serde 输出一致）----------
export interface ProcItem {
  name: string;
  cpu?: number; // %
  // 进程内存（字节），口径为 PSS（Proportional Set Size）：
  // 共享内存按进程数均分，之和≈整机真实进程内存占用。客户端需 root 才能采集到。
  mem?: number;
}

export interface DiskItem {
  mount: string;
  used: number;
  total: number;
  percent: number;
}

export interface NetItem {
  name: string;
  rx_rate: number; // bytes/s
  tx_rate: number; // bytes/s
}

export interface Report {
  device_id: string;
  hostname?: string;
  os_name?: string;
  os_version?: string;
  kernel?: string;
  arch?: string;
  uptime_seconds?: number;
  cpu_model?: string;
  cpu_cores?: number;
  total_memory?: number;
  available_memory?: number;
  ip_local?: string;
  cpu_percent?: number;
  memory_percent?: number;
  cpu_top?: ProcItem[];
  memory_top?: ProcItem[];
  disk?: DiskItem[];
  network?: NetItem[];
}

export interface DeviceRow {
  device_id: string;
  hostname: string | null;
  os_name: string | null;
  os_version: string | null;
  kernel: string | null;
  arch: string | null;
  uptime_seconds: number | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  total_memory: number | null;
  available_memory: number | null;
  ip_local: string | null;
  ip_public: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  cpu_top: string | null;
  memory_top: string | null;
  disk: string | null;
  network: string | null;
  last_seen: number | null;
  last_history_at: number | null;
}

export interface DeviceSummaryRow {
  device_id: string;
  hostname: string | null;
  os_name: string | null;
  os_version: string | null;
  ip_public: string | null;
  cpu_percent: number | null;
  memory_percent: number | null;
  last_seen: number | null;
}

export interface HistoryRow {
  ts: number;
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  net_rx: number;
  net_tx: number;
}

// ---------- 单例数据库 ----------
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbDir = path.dirname(config.dbPath);
  if (dbDir && dbDir !== ".") {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  _db = new Database(config.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("busy_timeout = 5000");
  initSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (!_db) return;
  _db.close();
  _db = null;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_latest (
      device_id        TEXT PRIMARY KEY,
      hostname         TEXT,
      os_name          TEXT,
      os_version       TEXT,
      kernel           TEXT,
      arch             TEXT,
      uptime_seconds   INTEGER,
      cpu_model        TEXT,
      cpu_cores        INTEGER,
      total_memory     INTEGER,
      available_memory INTEGER,
      ip_local         TEXT,
      ip_public        TEXT,
      cpu_percent      REAL,
      memory_percent   REAL,
      cpu_top          TEXT,
      memory_top       TEXT,
      disk             TEXT,
      network          TEXT,
      last_seen        INTEGER,
      last_history_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS metrics_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id      TEXT,
      ts             INTEGER,
      cpu_percent    REAL,
      memory_percent REAL,
      disk_percent   REAL,
      net_rx         REAL,
      net_tx         REAL
    );

    CREATE INDEX IF NOT EXISTS idx_history_device_ts
      ON metrics_history(device_id, ts);

    CREATE INDEX IF NOT EXISTS idx_device_latest_last_seen
      ON device_latest(last_seen DESC);
  `);
  ensureColumn(db, "device_latest", "available_memory", "INTEGER");
}

function ensureColumn(
  db: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string }[];
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

// ---------- 数据操作 ----------

// 写入实时数据（UPSERT）。返回当前时间戳。
export function upsertDevice(r: Report, ipPublic: string): number {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO device_latest
        (device_id, hostname, os_name, os_version, kernel, arch, uptime_seconds,
         cpu_model, cpu_cores, total_memory, available_memory, ip_local, ip_public,
         cpu_percent, memory_percent, cpu_top, memory_top, disk, network,
         last_seen, last_history_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NULL)
       ON CONFLICT(device_id) DO UPDATE SET
         hostname=excluded.hostname, os_name=excluded.os_name, os_version=excluded.os_version,
         kernel=excluded.kernel, arch=excluded.arch, uptime_seconds=excluded.uptime_seconds,
         cpu_model=excluded.cpu_model, cpu_cores=excluded.cpu_cores, total_memory=excluded.total_memory,
         available_memory=excluded.available_memory,
         ip_local=excluded.ip_local, ip_public=excluded.ip_public,
         cpu_percent=excluded.cpu_percent, memory_percent=excluded.memory_percent,
         cpu_top=excluded.cpu_top, memory_top=excluded.memory_top, disk=excluded.disk, network=excluded.network,
         last_seen=excluded.last_seen`,
    )
    .run(
      r.device_id,
      r.hostname ?? null,
      r.os_name ?? null,
      r.os_version ?? null,
      r.kernel ?? null,
      r.arch ?? null,
      r.uptime_seconds ?? null,
      r.cpu_model ?? null,
      r.cpu_cores ?? null,
      r.total_memory ?? null,
      availableMemory(r),
      r.ip_local ?? null,
      ipPublic,
      r.cpu_percent ?? null,
      r.memory_percent ?? null,
      r.cpu_top ? JSON.stringify(r.cpu_top) : null,
      r.memory_top ? JSON.stringify(r.memory_top) : null,
      r.disk ? JSON.stringify(r.disk) : null,
      r.network ? JSON.stringify(r.network) : null,
      now,
    );
  return now;
}

function availableMemory(r: Report): number | null {
  if (r.available_memory !== undefined) return r.available_memory;
  if (r.total_memory === undefined || r.memory_percent === undefined) return null;
  const usedRatio = Math.min(100, Math.max(0, r.memory_percent)) / 100;
  return Math.max(0, Math.round(r.total_memory * (1 - usedRatio)));
}

// 读取该设备上次写入历史的时间戳（用于 ~15s 控频）
export function getLastHistoryAt(deviceId: string): number | null {
  const row = getDb()
    .prepare("SELECT last_history_at FROM device_latest WHERE device_id = ?")
    .get(deviceId) as { last_history_at: number | null } | undefined;
  return row?.last_history_at ?? null;
}

// 标记已写入历史的时间戳
export function setLastHistoryAt(deviceId: string, ts: number): void {
  getDb()
    .prepare("UPDATE device_latest SET last_history_at = ? WHERE device_id = ?")
    .run(ts, deviceId);
}

// 插入一条历史采样
export function insertHistory(
  deviceId: string,
  ts: number,
  cpu: number,
  mem: number,
  diskPercent: number,
  netRx: number,
  netTx: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO metrics_history (device_id, ts, cpu_percent, memory_percent, disk_percent, net_rx, net_tx)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(deviceId, ts, cpu, mem, diskPercent, netRx, netTx);
}

export function listDevices(): DeviceSummaryRow[] {
  return getDb()
    .prepare(
      `SELECT device_id, hostname, os_name, os_version, ip_public, cpu_percent, memory_percent, last_seen
       FROM device_latest
       ORDER BY last_seen DESC`,
    )
    .all() as DeviceSummaryRow[];
}

export function getDevice(deviceId: string): DeviceRow | null {
  return (getDb()
    .prepare("SELECT * FROM device_latest WHERE device_id = ?")
    .get(deviceId) as DeviceRow | undefined) ?? null;
}

export function getHistory(deviceId: string, sinceTs: number): HistoryRow[] {
  return getDb()
    .prepare(
      `SELECT ts, cpu_percent, memory_percent, disk_percent, net_rx, net_tx
       FROM metrics_history
       WHERE device_id = ? AND ts >= ?
       ORDER BY ts ASC`,
    )
    .all(deviceId, sinceTs) as HistoryRow[];
}

// 删除早于 cutoffTs 的历史数据
export function deleteHistoryBefore(cutoffTs: number): void {
  getDb().prepare("DELETE FROM metrics_history WHERE ts < ?").run(cutoffTs);
}
