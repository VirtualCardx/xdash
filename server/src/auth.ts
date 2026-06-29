// 认证模块：基于 Node crypto 的 HMAC-SHA256，零运行时依赖。
//  - 客户端：预共享 DEVICE_TOKEN，WebSocket 握手时比对。
//  - 网页：WEB_PASSWORD 登录 → 派发签名 token；后续请求验签。
// token 格式：base64url(payload).base64url(signature)，与前端逻辑一致。

import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { config } from "./config.js";

// 定长比较，避免侧信道
function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkDeviceToken(provided: string | null): boolean {
  if (!provided) return false;
  return safeEqualStr(provided, config.deviceToken);
}

export function checkWebPassword(provided: string): boolean {
  return safeEqualStr(provided, config.webPassword);
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function b64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// 签名 payload（不含点号）
function sign(payload: string): string {
  return createHmac("sha256", config.jwtSecret).update(payload).digest("base64url");
}

// 派发会话 token：payload = {exp}, 签名 = HMAC(base64url(payload))
export function issueSessionToken(ttlHours = 24 * 7): string {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const payload = b64url(JSON.stringify({ exp }));
  return `${payload}.${sign(payload)}`;
}

// 验证会话 token
export function verifySessionToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;

  // 重新计算签名并比对（定时安全）
  const expected = sign(payload);
  if (!safeEqualStr(sig, expected)) return false;

  try {
    const { exp } = JSON.parse(b64urlDecode(payload).toString("utf8"));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// 从 Authorization 头解析 Bearer token
export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}
