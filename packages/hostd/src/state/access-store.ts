import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  AccessSchema,
  PENDING_CAP,
  defaultAccess,
  type Access,
} from "@mirza-harness/shared";

/**
 * Port dari `plugins/telegram/server.ts` (mirza-marketplace) — type `Access`
 * lama disimpan di `access.json` per-bot lewat fs. Fase 1 hostd memindahkan
 * penyimpanan itu ke tabel `channel_access(channel, bot_id, policy JSON)`
 * (lihat state-core, HEAD 6f567f7). Tidak ada fs.watch di jalur ini — semua
 * mutasi lewat API di bawah, jadi akar SCAR-021 (race antar penulis file)
 * hilang untuk state access.
 *
 * Skema (`AccessSchema`, `Access`, `PENDING_CAP`, `defaultAccess`) dipindah ke
 * `@mirza-harness/shared` (Task C2, Fase 1) supaya jadi satu sumber yang
 * dipakai bareng `telegram-adapter` (gate/pairing) tanpa telegram-adapter
 * depend ke hostd. Re-export di sini supaya pemanggil existing (test, dst.)
 * tidak perlu ganti path impor.
 *
 * Field, default, dan urutan validasi persis meniru `Access` lama supaya
 * `importLegacyAccessJson` bisa membaca access.json apa adanya.
 */

export { AccessSchema, PENDING_CAP, defaultAccess, type Access };

const DEFAULT_CHANNEL = "telegram";

/** TTL kode pairing — ikut kode acuan (1 jam). */
const PENDING_TTL_MS = 60 * 60 * 1000;

function loadRow(db: Database, botId: string, channel: string): Access {
  const row = db
    .query("SELECT policy FROM channel_access WHERE channel = ? AND bot_id = ?")
    .get(channel, botId) as { policy: string } | null;
  if (!row) return defaultAccess();
  return AccessSchema.parse(JSON.parse(row.policy));
}

function saveRow(db: Database, botId: string, access: Access, channel: string): Access {
  const validated = AccessSchema.parse(access);
  db.run(
    `INSERT INTO channel_access (channel, bot_id, policy) VALUES (?, ?, ?)
     ON CONFLICT(channel, bot_id) DO UPDATE SET policy = excluded.policy`,
    [channel, botId, JSON.stringify(validated)],
  );
  return validated;
}

/** Baca policy access utk (channel, botId). Baris tak ada → default access. */
export function getAccess(db: Database, botId: string, channel: string = DEFAULT_CHANNEL): Access {
  return loadRow(db, botId, channel);
}

/** Tulis policy access (validasi zod — input invalid akan throw ZodError). */
export function setAccess(
  db: Database,
  botId: string,
  access: Access,
  channel: string = DEFAULT_CHANNEL,
): Access {
  return saveRow(db, botId, access, channel);
}

/**
 * Pindahkan userId dari `pending` ke `allowFrom` (mirip alur `pair <code>`
 * di skill lama, tapi dikunci ke userId bukan code — code di-generate &
 * dicocokkan di layer atas). Idempotent: dipanggil lagi utk userId yang
 * sudah allowFrom & sudah tak ada di pending — no-op, tidak throw.
 */
export function approvePairing(
  db: Database,
  botId: string,
  userId: string,
  channel: string = DEFAULT_CHANNEL,
): Access {
  const access = loadRow(db, botId, channel);
  if (!access.allowFrom.includes(userId)) {
    access.allowFrom.push(userId);
  }
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.senderId === userId) {
      delete access.pending[code];
    }
  }
  return saveRow(db, botId, access, channel);
}

export type AddPendingResult = { ok: true; access: Access } | { ok: false; reason: string };

/**
 * Tambah entri pending pairing baru (keyed by `code`). Cap jumlah pending
 * di `PENDING_CAP` (3) — ikut kode acuan "Cap pending at 3. Extra attempts
 * are silently dropped." Di sini kegagalan dikembalikan sbg
 * `{ok:false, reason}`, bukan silent-drop, supaya caller bisa memutuskan.
 */
export function addPending(
  db: Database,
  botId: string,
  userId: string,
  code: string,
  channel: string = DEFAULT_CHANNEL,
): AddPendingResult {
  const access = loadRow(db, botId, channel);
  const alreadyThisCode = code in access.pending;
  if (!alreadyThisCode && Object.keys(access.pending).length >= PENDING_CAP) {
    return { ok: false, reason: `pending cap (${PENDING_CAP}) reached` };
  }
  const now = Date.now();
  access.pending[code] = {
    senderId: userId,
    chatId: userId, // Telegram DM: chat_id == user_id (lihat komentar assertAllowedChat di server.ts)
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS,
    replies: 1,
  };
  return { ok: true, access: saveRow(db, botId, access, channel) };
}

export type ImportLegacyResult = { ok: true; access: Access } | { ok: false; reason: string };

/**
 * Migrasi access.json lama → tabel channel_access. Semantik SCAR-078: file
 * korup (JSON rusak atau lolos JSON.parse tapi gagal validasi skema) TIDAK
 * di-throw — dikembalikan `{ok:false, reason}` dan caller yang memutuskan
 * apakah file itu perlu di-rename `.corrupt-<ts>` (fungsi ini sengaja tidak
 * menyentuh filesystem selain baca).
 */
export function importLegacyAccessJson(
  db: Database,
  botId: string,
  filePath: string,
  channel: string = DEFAULT_CHANNEL,
): ImportLegacyResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, reason: `read failed: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON: ${(err as Error).message}` };
  }

  const result = AccessSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: `schema validation failed: ${result.error.message}` };
  }

  return { ok: true, access: saveRow(db, botId, result.data, channel) };
}
