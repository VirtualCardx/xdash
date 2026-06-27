// 全局环境绑定类型定义（D1 数据库 + 静态资源 + secrets）

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  DEVICE_TOKEN: string;
  WEB_PASSWORD: string;
  JWT_SECRET: string;
  HISTORY_DAYS?: string;
}
