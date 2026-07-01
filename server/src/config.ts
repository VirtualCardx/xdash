// 集中读取环境变量配置（替代 Cloudflare 的 env 绑定）。
// 从项目根目录的 .env 文件加载（dotenv），再读 process.env。

import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`错误：缺少必需环境变量 ${key}`);
    process.exit(1);
  }
  return v;
}

function numberEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`错误：环境变量 ${key} 必须是 ${min} 到 ${max} 之间的数字`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: numberEnv("PORT", 3000, 1, 65535),
  // 客户端握手 token（必须与 Rust 客户端 XDASH_TOKEN 一致）
  deviceToken: required("DEVICE_TOKEN"),
  // 网页登录密码
  webPassword: required("WEB_PASSWORD"),
  // 会话签名密钥（建议随机长串）
  jwtSecret: required("JWT_SECRET"),
  // SQLite 数据库文件路径
  dbPath: process.env.DB_PATH ?? "./data/xdash.db",
  // 静态网页资源目录
  webDir: process.env.WEB_DIR ?? "../web",
  // 历史数据保留天数（默认 7）
  historyDays: numberEnv("HISTORY_DAYS", 7, 1, 3650),
  // 是否信任反向代理（nginx 等设为 true，以读取真实公网 IP）
  trustProxy: process.env.TRUST_PROXY === "true",
};

export type Config = typeof config;
