import { Database } from "bun:sqlite";
import { applySchema } from "@mirza-harness/shared";

/**
 * Retention policy keys stored in the `kv` table (INFRA-6). Values are
 * plain decimal strings (jumlah hari). Absent or non-positive/non-numeric
 * values fall back to the defaults below.
 */
const RETENTION_DEFAULTS = {
  "retention.messages_days": 90,
  "retention.bus_dead_days": 30,
} as const;

const SECONDS_PER_DAY = 86400;

/**
 * Buka (atau buat) database SQLite di `path` — pakai `:memory:` untuk DB
 * sementara (mis. test). Menerapkan pragma standar hostd, lalu skema, lalu
 * sapuan retensi satu kali di titik buka.
 *
 * Catatan `journal_mode=WAL`: untuk file DB sungguhan pragma ini akan aktif
 * (`wal`). Untuk `:memory:`, SQLite tidak pernah mengizinkan WAL pada
 * database in-memory — pragma tetap diterapkan tanpa error, hasilnya cukup
 * dibaca sebagai `'memory'` (bukan kegagalan).
 */
export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  applySchema(db);
  runRetention(db);
  return db;
}

function readPolicyDays(db: Database, key: keyof typeof RETENTION_DEFAULTS): number {
  const row = db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return RETENTION_DEFAULTS[key];
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : RETENTION_DEFAULTS[key];
}

/**
 * Hapus baris `messages` dan `bus_dead` yang lebih tua dari kebijakan
 * retensi (dibaca dari tabel `kv`, default 90 hari / 30 hari). Cutoff
 * dihitung dalam unix seconds, dibandingkan terhadap kolom `ts` (messages)
 * dan `dead_at` (bus_dead).
 */
export function runRetention(db: Database): void {
  const now = Math.floor(Date.now() / 1000);

  const messagesDays = readPolicyDays(db, "retention.messages_days");
  const messagesCutoff = now - messagesDays * SECONDS_PER_DAY;
  db.run("DELETE FROM messages WHERE ts < ?", [messagesCutoff]);

  const busDeadDays = readPolicyDays(db, "retention.bus_dead_days");
  const busDeadCutoff = now - busDeadDays * SECONDS_PER_DAY;
  db.run("DELETE FROM bus_dead WHERE dead_at < ?", [busDeadCutoff]);
}
