// 历史数据清理：每次有数据写入时按一定概率触发删除，避免历史表无限增长。
// （Node 常驻进程其实也可以用 setInterval 定时清理，这里保留懒删除 +
// 启动一个低频定时器双保险。）

import { config } from "./config.js";
import { deleteHistoryBefore } from "./db.js";

const CLEANUP_PROBABILITY = 0.02; // ~2% 的写入会顺带清理一次
const TIMER_INTERVAL_MS = 6 * 3600 * 1000; // 每 6 小时定时清理一次

export function shouldRunCleanup(): boolean {
  return Math.random() < CLEANUP_PROBABILITY;
}

export function maybeCleanup(): void {
  const cutoff = Math.floor(Date.now() / 1000) - config.historyDays * 86400;
  deleteHistoryBefore(cutoff);
}

// 启动一个低频定时清理器，作为懒删除的补充
export function startCleanupTimer(): void {
  setInterval(() => {
    try {
      maybeCleanup();
    } catch (e) {
      console.error("[cleanup] 定时清理失败", e);
    }
  }, TIMER_INTERVAL_MS).unref();
}
