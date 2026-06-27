// 历史数据清理：免费版无 Cron Triggers（Cron 需要 Workers Paid），改用"懒删除"。
// 每次有数据写入时，按一定概率触发一次删除，避免历史表无限增长。
// （若将来升级到 Paid 版，可在 wrangler.toml 配 [triggers] crons 改为定时清理）

const CLEANUP_PROBABILITY = 0.02; // ~2% 的写入会顺带清理一次

export function shouldRunCleanup(): boolean {
  return Math.random() < CLEANUP_PROBABILITY;
}

export async function maybeCleanup(db: D1Database, historyDays: number): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - historyDays * 86400;
  const { deleteHistoryBefore } = await import("./db");
  await deleteHistoryBefore(db, cutoff);
}
