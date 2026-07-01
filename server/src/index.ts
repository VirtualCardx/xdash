// 服务端入口：Express HTTP 服务 + ws WebSocket 接收。
// 路由：
//   /ws          → WebSocket 接收（ws.ts，在 HTTP upgrade 阶段拦截）
//   /api/*       → HTTP API（api.ts Router）
//   其余          → 静态网页资源（express.static）

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { closeDb, getDb } from "./db.js";
import { apiRouter } from "./api.js";
import { attachWs } from "./ws.js";
import { startCleanupTimer } from "./cleanup.js";

// ESM 下没有 __dirname，用 import.meta.url 构造
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// 项目 server/ 目录：ts 直接运行时 __dirname=src/，编译后运行时 __dirname=dist/，
// 两种情况下 server 根都是 __dirname 的父目录。
const serverRoot = path.resolve(__dirname, "..");

// 启动时初始化数据库（建表）
getDb();
// 启动低频历史清理定时器
startCleanupTimer();

const app = express();

// 若在 nginx 等反向代理后运行，信任代理以读取真实公网 IP
if (config.trustProxy) {
  app.set("trust proxy", 1);
}

app.disable("x-powered-by");

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

// JSON body 解析（/api/login 用），限制体积避免无意义的大请求占用内存
app.use(express.json({ limit: "16kb" }));
app.use(jsonErrorHandler);

// API 路由
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", apiRouter);
app.use("/api", apiErrorHandler);

// 静态网页资源（相对 server/ 根目录解析，兼容 ts 直接运行与编译后运行）
const webDir = path.resolve(serverRoot, config.webDir);
if (!fs.existsSync(webDir)) {
  console.warn(`[warn] 静态资源目录不存在: ${webDir}`);
}
app.use(
  express.static(webDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      } else {
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  }),
);
// SPA 回退：未命中的非 API 路径返回 index.html
app.get(/^\/(?!api|ws).*/, (_req, res) => {
  const indexFile = path.join(webDir, "index.html");
  if (fs.existsSync(indexFile)) {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(indexFile);
  } else {
    res.status(404).send("Not Found");
  }
});

const server = app.listen(config.port, () => {
  console.log(`[xdash] 服务已启动 → http://localhost:${config.port}`);
  console.log(`[xdash] 静态资源: ${webDir}`);
  console.log(`[xdash] 数据库: ${path.resolve(config.dbPath)}`);
});

// 挂载 WebSocket
const wss = attachWs(server);

// 优雅退出
function shutdown(signal: string): void {
  console.log(`\n[xdash] 收到 ${signal}，正在关闭...`);
  for (const client of wss.clients) {
    client.close(1001, "server shutdown");
  }
  wss.close();
  server.close(() => {
    closeDb();
    console.log("[xdash] 已关闭");
    process.exit(0);
  });
  // 兜底：5s 后强制退出
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function jsonErrorHandler(err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction): void {
  const typedErr = err as { type?: string } | undefined;
  if (err instanceof SyntaxError || typedErr?.type === "entity.too.large") {
    res.status(typedErr?.type === "entity.too.large" ? 413 : 400).json({
      ok: false,
      error: typedErr?.type === "entity.too.large" ? "请求体过大" : "JSON 格式错误",
    });
    return;
  }
  next(err);
}

function apiErrorHandler(err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction): void {
  console.error("[api] unhandled error", err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: "服务端错误" });
}
