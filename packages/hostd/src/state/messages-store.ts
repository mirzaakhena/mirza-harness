import { Database } from "bun:sqlite";

/**
 * Port of plugins/telegram/messages-store.ts (mirza-marketplace) adapted for
 * the shared hostd `messages` table (packages/shared/src/schema.ts, A1).
 *
 * Differences from the ported source (see .superpowers/sdd/f1/task-A2-brief.md):
 * - The `Database` is supplied by the caller (opened via `openDb`, schema
 *   already applied) — this store never opens or migrates its own file.
 * - Old `text` column -> `body` (NOT NULL in the new schema; missing/omitted
 *   text is stored as `''`, never `null`).
 * - New `bot_id` + `channel` columns scope every read/write; both are bound
 *   at construction time (one store instance = one bot+channel).
 * - New `direction` column: `'in'` for logInbound, `'out'` for logOutbound.
 *   `source` keeps its old meaning (`'user' | 'assistant' | 'system'`).
 * - `reply_to` is no longer its own column in the final schema — it is
 *   folded into `metadata.reply_to`, the same way `quote_text` /
 *   `quote_is_manual` were already metadata-only fields in the source.
 * - `logEdit` is NOT ported (design doc §10.5 removed edit_message).
 * - LOSS-4 fix: there is no `append` method. Anything that used to call
 *   `append` for session-change/system events now calls
 *   `logOutbound({ source: 'system', ... })` instead.
 * - SCAR-097: `enabled: false` degrades every method to a silent no-op
 *   (never throws), instead of the source's disable-via-env-var + failed-init
 *   fallback. There is no `init()` — the schema is guaranteed by `openDb`.
 * - Adds `searchFts` on top of `messages_fts` (fondasi IDEA-3).
 */

export type MessageSource = "user" | "assistant" | "system";
export type MessageDirection = "in" | "out";

export interface InboundLogInput {
  ts: number;
  chat_id: string;
  message_id?: string;
  user_id?: string;
  user_name?: string;
  body?: string;
  attachments?: unknown[];
  reply_to?: string;
  metadata?: Record<string, unknown>;
  /** Merged into `metadata` (see server-helpers.extractQuoteText upstream). */
  quote_text?: string;
  quote_is_manual?: boolean;
}

export interface OutboundLogInput {
  ts: number;
  chat_id: string;
  message_id?: string;
  source: Extract<MessageSource, "assistant" | "system">;
  body?: string;
  attachments?: unknown[];
  reply_to?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A row returned by `getMessage` / `searchFts`. `attachments` and `metadata`
 * are parsed back into structured values (vs. the raw JSON text stored in
 * the DB). `reply_to` lives only inside `metadata` (no dedicated column).
 */
export interface StoredMessage {
  chat_id: string;
  message_id: string | null;
  direction: MessageDirection;
  source: MessageSource | null;
  ts: number;
  body: string;
  user_id: string | null;
  user_name: string | null;
  attachments: unknown[] | null;
  metadata: Record<string, unknown> | null;
}

export interface MessagesStoreOptions {
  db: Database;
  botId: string;
  channel: string;
  /** SCAR-097: when false, every method is a silent no-op. Default true. */
  enabled?: boolean;
}

export interface MessagesStore {
  logInbound(input: InboundLogInput): void;
  logOutbound(input: OutboundLogInput): void;
  /**
   * Look up a single message by `(chat_id, message_id)`, scoped to this
   * store's bot_id/channel. Returns the row with `attachments` and
   * `metadata` already JSON-parsed, or `null` when not found. Album items
   * 2..N — whose IDs are stored only inside `metadata.message_ids` of the
   * album's first-item row — are resolved via a fallback scan; see
   * docs/2026-05-20-get-message-by-id.md (mirza-marketplace) for rationale.
   */
  getMessage(chat_id: string, message_id: string): StoredMessage | null;
  /** Full-text search over `messages_fts`, scoped to this bot_id/channel. */
  searchFts(query: string, limit?: number): StoredMessage[];
  // Test-only escape hatch for inspecting the (caller-owned) DB.
  _dbForTest(): Database;
}

interface RawRow {
  chat_id: string;
  message_id: string | null;
  direction: string;
  source: string | null;
  ts: number;
  body: string;
  user_id: string | null;
  user_name: string | null;
  attachments: string | null;
  metadata: string | null;
}

function safeParseArray(json: string): unknown[] | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function safeParseMetadata(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function rowToStoredMessage(row: RawRow): StoredMessage {
  return {
    chat_id: row.chat_id,
    message_id: row.message_id,
    direction: row.direction as MessageDirection,
    source: row.source as MessageSource | null,
    ts: row.ts,
    body: row.body,
    user_id: row.user_id,
    user_name: row.user_name,
    attachments: row.attachments ? safeParseArray(row.attachments) : null,
    metadata: safeParseMetadata(row.metadata),
  };
}

const ROW_COLUMNS =
  "chat_id, message_id, direction, source, ts, body, user_id, user_name, attachments, metadata";

export function createMessagesStore(opts: MessagesStoreOptions): MessagesStore {
  const { db, botId, channel } = opts;
  const enabled = opts.enabled ?? true;

  function warn(stage: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hostd: messages-store ${stage} failed: ${msg}\n`);
  }

  return {
    logInbound(input: InboundLogInput): void {
      if (!enabled) return;
      try {
        const mergedMeta: Record<string, unknown> = { ...(input.metadata ?? {}) };
        if (input.reply_to != null) mergedMeta.reply_to = input.reply_to;
        if (input.quote_text != null) mergedMeta.quote_text = input.quote_text;
        if (input.quote_is_manual != null) mergedMeta.quote_is_manual = input.quote_is_manual;
        const metaJson = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

        db.prepare(
          `INSERT INTO messages
            (bot_id, channel, chat_id, message_id, direction, source, user_id, user_name, ts, body, attachments, metadata)
           VALUES (?, ?, ?, ?, 'in', 'user', ?, ?, ?, ?, ?, ?)`,
        ).run(
          botId,
          channel,
          input.chat_id,
          input.message_id ?? null,
          input.user_id ?? null,
          input.user_name ?? null,
          input.ts,
          input.body ?? "",
          input.attachments ? JSON.stringify(input.attachments) : null,
          metaJson,
        );
      } catch (err) {
        warn("write", err);
      }
    },
    logOutbound(input: OutboundLogInput): void {
      if (!enabled) return;
      try {
        const mergedMeta: Record<string, unknown> = { ...(input.metadata ?? {}) };
        if (input.reply_to != null) mergedMeta.reply_to = input.reply_to;
        const metaJson = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

        db.prepare(
          `INSERT INTO messages
            (bot_id, channel, chat_id, message_id, direction, source, ts, body, attachments, metadata)
           VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?)`,
        ).run(
          botId,
          channel,
          input.chat_id,
          input.message_id ?? null,
          input.source,
          input.ts,
          input.body ?? "",
          input.attachments ? JSON.stringify(input.attachments) : null,
          metaJson,
        );
      } catch (err) {
        warn("write", err);
      }
    },
    getMessage(chat_id: string, message_id: string): StoredMessage | null {
      if (!enabled) return null;
      try {
        // Step 1 — direct hit on (bot_id, channel, chat_id, message_id).
        // Latest row wins if duplicates were ever inserted. Order by ts DESC.
        let row = db
          .prepare(
            `SELECT ${ROW_COLUMNS}
               FROM messages
              WHERE bot_id = ? AND channel = ? AND chat_id = ? AND message_id = ?
              ORDER BY ts DESC
              LIMIT 1`,
          )
          .get(botId, channel, chat_id, message_id) as RawRow | null;

        // Step 2 — album fallback. Album rows are keyed on the first item's
        // message_id; other items' IDs live only in metadata.message_ids.
        // Substring-LIKE narrows candidates; then we parse and verify to
        // avoid false positives (e.g. the digit sequence happens to appear
        // inside some unrelated metadata value).
        if (!row) {
          const needle = `"${message_id}"`;
          const candidates = db
            .prepare(
              `SELECT ${ROW_COLUMNS}
                 FROM messages
                WHERE bot_id = ? AND channel = ? AND chat_id = ?
                  AND metadata IS NOT NULL AND metadata LIKE ?
                ORDER BY ts DESC`,
            )
            .all(botId, channel, chat_id, `%${needle}%`) as RawRow[];

          for (const cand of candidates) {
            const parsed = safeParseMetadata(cand.metadata);
            const ids = parsed?.message_ids;
            if (Array.isArray(ids) && ids.some((v) => String(v) === message_id)) {
              row = cand;
              break;
            }
          }
        }

        if (!row) return null;
        return rowToStoredMessage(row);
      } catch (err) {
        warn("read", err);
        return null;
      }
    },
    searchFts(query: string, limit = 20): StoredMessage[] {
      if (!enabled) return [];
      try {
        const rows = db
          .prepare(
            `SELECT m.chat_id, m.message_id, m.direction, m.source, m.ts, m.body,
                    m.user_id, m.user_name, m.attachments, m.metadata
               FROM messages_fts f
               JOIN messages m ON m.id = f.rowid
              WHERE f.body MATCH ? AND m.bot_id = ? AND m.channel = ?
              ORDER BY m.ts DESC
              LIMIT ?`,
          )
          .all(query, botId, channel, limit) as RawRow[];
        return rows.map(rowToStoredMessage);
      } catch (err) {
        warn("search", err);
        return [];
      }
    },
    _dbForTest(): Database {
      return db;
    },
  };
}
