// D1 数据访问层。所有 SQL 集中在此，便于维护。
// 客户端上报的 Report 结构（与 Rust 客户端 serde 输出保持一致）

export interface ProcItem {
  name: string;
  cpu?: number; // %
  mem?: number; // %
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

// 写入实时数据（UPSERT）。返回当前时间戳，便于上层判断是否要写历史。
export async function upsertDevice(
  db: D1Database,
  r: Report,
  ipPublic: string,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO device_latest
        (device_id, hostname, os_name, os_version, kernel, arch, uptime_seconds,
         cpu_model, cpu_cores, total_memory, ip_local, ip_public,
         cpu_percent, memory_percent, cpu_top, memory_top, disk, network,
         last_seen, last_history_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NULL)
       ON CONFLICT(device_id) DO UPDATE SET
         hostname=excluded.hostname, os_name=excluded.os_name, os_version=excluded.os_version,
         kernel=excluded.kernel, arch=excluded.arch, uptime_seconds=excluded.uptime_seconds,
         cpu_model=excluded.cpu_model, cpu_cores=excluded.cpu_cores, total_memory=excluded.total_memory,
         ip_local=excluded.ip_local, ip_public=excluded.ip_public,
         cpu_percent=excluded.cpu_percent, memory_percent=excluded.memory_percent,
         cpu_top=excluded.cpu_top, memory_top=excluded.memory_top, disk=excluded.disk, network=excluded.network,
         last_seen=excluded.last_seen`,
    )
    .bind(
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
      r.ip_local ?? null,
      ipPublic,
      r.cpu_percent ?? null,
      r.memory_percent ?? null,
      r.cpu_top ? JSON.stringify(r.cpu_top) : null,
      r.memory_top ? JSON.stringify(r.memory_top) : null,
      r.disk ? JSON.stringify(r.disk) : null,
      r.network ? JSON.stringify(r.network) : null,
      now,
    )
    .run();
  return now;
}

// 读取该设备上次写入历史的时间戳（用于 ~15s 控频）
export async function getLastHistoryAt(db: D1Database, deviceId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT last_history_at FROM device_latest WHERE device_id = ?")
    .bind(deviceId)
    .first<{ last_history_at: number | null }>();
  return row?.last_history_at ?? null;
}

// 标记已写入历史的时间戳
export async function setLastHistoryAt(
  db: D1Database,
  deviceId: string,
  ts: number,
): Promise<void> {
  await db
    .prepare("UPDATE device_latest SET last_history_at = ? WHERE device_id = ?")
    .bind(ts, deviceId)
    .run();
}

// 插入一条历史采样
export async function insertHistory(
  db: D1Database,
  deviceId: string,
  ts: number,
  cpu: number,
  mem: number,
  diskPercent: number,
  netRx: number,
  netTx: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO metrics_history (device_id, ts, cpu_percent, memory_percent, disk_percent, net_rx, net_tx)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(deviceId, ts, cpu, mem, diskPercent, netRx, netTx)
    .run();
}

export async function listDevices(db: D1Database): Promise<DeviceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM device_latest ORDER BY last_seen DESC")
    .all<DeviceRow>();
  return results;
}

export async function getDevice(db: D1Database, deviceId: string): Promise<DeviceRow | null> {
  return db
    .prepare("SELECT * FROM device_latest WHERE device_id = ?")
    .bind(deviceId)
    .first<DeviceRow>();
}

export async function getHistory(
  db: D1Database,
  deviceId: string,
  sinceTs: number,
): Promise<
  {
    ts: number;
    cpu_percent: number;
    memory_percent: number;
    disk_percent: number;
    net_rx: number;
    net_tx: number;
  }[]
> {
  const { results } = await db
    .prepare(
      `SELECT ts, cpu_percent, memory_percent, disk_percent, net_rx, net_tx
       FROM metrics_history
       WHERE device_id = ? AND ts >= ?
       ORDER BY ts ASC`,
    )
    .bind(deviceId, sinceTs)
    .all<{
      ts: number;
      cpu_percent: number;
      memory_percent: number;
      disk_percent: number;
      net_rx: number;
      net_tx: number;
    }>();
  return results;
}

// 删除早于 cutoffTs 的历史数据
export async function deleteHistoryBefore(db: D1Database, cutoffTs: number): Promise<void> {
  await db.prepare("DELETE FROM metrics_history WHERE ts < ?").bind(cutoffTs).run();
}
