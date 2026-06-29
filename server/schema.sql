-- xdash SQLite 数据库建表脚本（参考用）。
-- 服务端启动时会自动执行等价的 CREATE TABLE IF NOT EXISTS，通常无需手动运行。
-- 如需手动初始化（例如用 sqlite3 CLI）：
--   sqlite3 data/xdash.db < schema.sql

-- 设备实时最新值（每 ~3s UPSERT 一次）
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
  ip_local         TEXT,
  ip_public        TEXT,
  cpu_percent      REAL,
  memory_percent   REAL,
  cpu_top          TEXT,   -- JSON 字符串: [{"name","cpu"}]
  memory_top       TEXT,   -- JSON 字符串: [{"name","mem"}]
  disk             TEXT,   -- JSON 字符串: [{"mount","used","total","percent"}]
  network          TEXT,   -- JSON 字符串: [{"name","rx_rate","tx_rate"}]
  last_seen        INTEGER,
  last_history_at  INTEGER
);

-- 历史采样点（每 ~15s 插入一条，供趋势图）
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

CREATE INDEX IF NOT EXISTS idx_history_device_ts ON metrics_history(device_id, ts);
