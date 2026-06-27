// 认证模块：基于 Web Crypto 的 HMAC-SHA256，零依赖。
//  - 客户端：预共享 DEVICE_TOKEN，WebSocket 握手时比对。
//  - 网页：WEB_PASSWORD 登录 → 派发签名 token；后续请求验签。

import type { Env } from "./env";

const enc = new TextEncoder();
const dec = new TextDecoder();

// 定时比较，避免侧信道
function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function checkDeviceToken(env: Env, provided: string | null): boolean {
  if (!provided) return false;
  return timingEqual(provided, env.DEVICE_TOKEN);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const s = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 派发会话 token：payload = {exp}, 签名 = HMAC(base64url(payload))
export async function issueSessionToken(env: Env, ttlHours = 24 * 7): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlHours * 3600;
  const payload = b64url(enc.encode(JSON.stringify({ exp })));
  const sig = await hmacKey(env.JWT_SECRET).then((k) =>
    crypto.subtle.sign("HMAC", k, enc.encode(payload)),
  );
  return `${payload}.${b64url(sig)}`;
}

// 验证会话 token，通过返回 true
export async function verifySessionToken(env: Env, token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(sig);
  } catch {
    return false;
  }
  const key = await hmacKey(env.JWT_SECRET);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(payload));
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(dec.decode(b64urlDecode(payload)));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// 校验网页登录密码
export function checkWebPassword(env: Env, provided: string): boolean {
  return timingEqual(provided, env.WEB_PASSWORD);
}

// 从 Authorization 头解析 Bearer token
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}
