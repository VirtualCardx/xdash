// 路由入口：
//  /ws          → WebSocket 接收（ws.ts）
//  /api/*       → HTTP API（api.ts）
//  其余请求      → 静态网页资源（通过 ASSETS 绑定回退）

import { handleWs } from "./ws";
import { handleApi } from "./api";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket 接收端点
    if (path === "/ws") {
      return handleWs(request, env);
    }

    // HTTP API
    if (path === "/api/login" || path.startsWith("/api/")) {
      return handleApi(request, env, path);
    }

    // 其余：交给静态资源绑定（Workers Static Assets）
    return env.ASSETS.fetch(request);
  },
};
