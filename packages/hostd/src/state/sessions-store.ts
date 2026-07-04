import type { Database } from "bun:sqlite";

/**
 * Small helper around the `sessions` table (schema.ts) needed by
 * `supervisor.ts`'s `clearSession` — everything else about session rows
 * (the actual INSERT on `SessionStart`) is H1's job (recon-hooks.md §B point
 * 2, "hostd tulis baris sesi"), not built yet in this phase. This module
 * only UPDATEs the lifecycle column of whatever row already exists.
 */

/**
 * Set `lifecycle` on the bot's most-recently-started session row (mirrors
 * `rpc-handlers.ts`'s `agent.status` query — "ORDER BY started_at DESC LIMIT
 * 1"). No-op (returns `false`) if the bot has no session row yet — that's
 * expected before the first `SessionStart` hook fires; there's nothing to
 * mark "resetting" yet.
 */
export function setLatestSessionLifecycle(db: Database, botId: string, lifecycle: string): boolean {
  const row = db
    .query(`SELECT id FROM sessions WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(botId) as { id: string } | null;
  if (!row) return false;
  db.run(`UPDATE sessions SET lifecycle = ? WHERE id = ?`, [lifecycle, row.id]);
  return true;
}
