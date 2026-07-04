import type { Database } from "bun:sqlite";

/**
 * DRAFT skema fase 0 — skema FINAL ditetapkan di fase 1 (design doc §4.4).
 * Sengaja minim kolom; jangan tambah kolom "sekalian" tanpa kebutuhan fase berjalan (YAGNI).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,                -- 'bot-01'..'bot-06'
  workspace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',  -- offline|starting|online|degraded
  last_heartbeat_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                -- session_id dari hook SessionStart
  bot_id TEXT NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL DEFAULT 'idle',
  lifecycle TEXT NOT NULL DEFAULT 'idle',  -- idle|busy|resetting|dead
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  -- Task M2, Fase 2 -- kolom telemetri statusline (recon-hooks.md paragraf E),
  -- diisi oleh RPC telemetry.report (cc-stub's scripts/context-bridge.ts,
  -- dipicu CC statusLine). SEMUA nullable: belum ada snapshot statusLine
  -- (belum pernah "fire") = NULL, bukan 0/"" -- FUNC-1 fix (/context dan
  -- agent_status harus bisa membedakan "belum ada data" dari "nilai nol
  -- asli"). Ditambah di sini untuk DB baru; migrateSessionsTelemetryColumns
  -- di bawah menambahkannya via ALTER TABLE untuk DB lama yang sudah ada
  -- baris sessions sebelum kolom ini ada (CREATE TABLE IF NOT EXISTS tidak
  -- menyentuh tabel yang sudah tercipta).
  used_percentage REAL,
  context_window_size INTEGER,
  model TEXT,
  effort TEXT,
  cost REAL,
  captured_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  channel TEXT NOT NULL,              -- 'telegram' (nanti: wa/discord/web)
  chat_id TEXT NOT NULL,
  message_id TEXT,
  direction TEXT NOT NULL,            -- in|out
  source TEXT,                        -- user|assistant|system
  user_id TEXT,
  user_name TEXT,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  attachments TEXT,                   -- JSON string (array)
  metadata TEXT                       -- JSON string (album, buttons, quote, ...)
);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(body, content='messages', content_rowid='id');

-- Sinkronisasi messages_fts otomatis (external content table, lihat
-- https://sqlite.org/fts5.html#external_content_tables). Trigger dipasang di
-- sini (bukan di hostd) supaya siapa pun yang menulis ke messages langsung
-- lewat SQL tetap menjaga index tetap konsisten.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;

CREATE TABLE IF NOT EXISTS bus_queue (
  id TEXT PRIMARY KEY,                -- envelope id (idempotency key)
  ts INTEGER NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,              -- JSON string
  hop INTEGER NOT NULL DEFAULT 0,
  reply_to TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  acked_at INTEGER
);

CREATE TABLE IF NOT EXISTS bus_dead (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  envelope TEXT NOT NULL,             -- JSON envelope utuh
  reason TEXT NOT NULL,
  dead_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  spec TEXT NOT NULL,                 -- JSON
  status TEXT NOT NULL DEFAULT 'active',   -- active|done|abandoned
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  file_path TEXT,
  designation TEXT,                   -- now|after-this-task|ping-pong|file-only
  pair TEXT,                          -- partner ping-pong, bila ada
  status TEXT NOT NULL DEFAULT 'sent',     -- sent|acked|done
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS channel_access (
  channel TEXT NOT NULL,              -- 'telegram'
  bot_id TEXT NOT NULL,
  policy TEXT NOT NULL,               -- JSON (port access.json: dmPolicy, allowFrom, groups, pending)
  PRIMARY KEY (channel, bot_id)
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Task S2, Fase 2 — soft-delete marker for session-ops' listSessions/archive
-- flow. Port of plugins/telegram/archive-store.ts's archived-sessions.json
-- (mirza-marketplace) to a table, per that task's brief ("port archive-store
-- ke tabel atau file setara"). session_id here may reference a jsonl-only
-- session that never got a \`sessions\` row (pre-migration history) — no FK
-- to sessions(id) on purpose. Archiving never touches the jsonl file on disk
-- (matches the ported source's "unarchiving is intentionally not exposed"
-- semantics) or (row 'hard delete') removes it here too.
CREATE TABLE IF NOT EXISTS session_archive (
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archived_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (bot_id, session_id)
);
`;

/**
 * Task M2, Fase 2 — additive migration for `sessions`' telemetry columns
 * (see the CREATE TABLE comment above). `CREATE TABLE IF NOT EXISTS` only
 * helps brand-new databases; a DB file created before this task exists
 * already has a `sessions` table WITHOUT these columns, and that statement
 * is then a no-op. This walks `PRAGMA table_info` and `ALTER TABLE ... ADD
 * COLUMN`s in whichever are missing — idempotent (checks presence first),
 * additive only (never touches an existing column), and safe to call on
 * every `applySchema` (including `:memory:` test DBs, where the CREATE
 * TABLE above already included them and this loop is simply a no-op).
 */
const SESSION_TELEMETRY_COLUMNS: ReadonlyArray<{ name: string; ddlType: string }> = [
  { name: "used_percentage", ddlType: "REAL" },
  { name: "context_window_size", ddlType: "INTEGER" },
  { name: "model", ddlType: "TEXT" },
  { name: "effort", ddlType: "TEXT" },
  { name: "cost", ddlType: "REAL" },
  { name: "captured_at_ms", ddlType: "INTEGER" },
];

function migrateSessionsTelemetryColumns(db: Database): void {
  const existing = new Set(
    (db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[]).map(row => row.name),
  );
  for (const col of SESSION_TELEMETRY_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.ddlType}`);
    }
  }
}

export function applySchema(db: Database): void {
  db.exec(SCHEMA_SQL);
  migrateSessionsTelemetryColumns(db);
}
