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

export const config = {
  port: Number(process.env.PORT ?? 3000),
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
  historyDays: Number(process.env.HISTORY_DAYS ?? 7),
  // 是否信任反向代理（nginx 等设为 true，以读取真实公网 IP）
  trustProxy: process.env.TRUST_PROXY === "true",
};

export type Config = typeof config;
