import { z } from "zod";

/**
 * Port dari `plugins/telegram/server.ts` (mirza-marketplace) — type `Access`
 * lama disimpan di `access.json` per-bot lewat fs. Dipindah ke sini dari
 * `packages/hostd/src/state/access-store.ts` (Task C2, Fase 1) supaya jadi
 * SATU sumber skema — `packages/hostd` (persistence, DB-backed) dan
 * `packages/telegram-adapter` (gate/pairing, modul murni) sama-sama
 * mengimpor dari sini tanpa saling depend satu sama lain (arah dependensi:
 * hostd → shared, telegram-adapter → shared).
 *
 * Field, default, dan urutan validasi persis meniru `Access` lama supaya
 * `importLegacyAccessJson` (hostd) bisa membaca access.json apa adanya.
 */

/** Cap pending pairing per bot — nilai ini ikut kode acuan (`server.ts`: "Cap pending at 3"). */
export const PENDING_CAP = 3;

export const PendingEntrySchema = z
  .object({
    senderId: z.string(),
    chatId: z.string(),
    createdAt: z.number(),
    expiresAt: z.number(),
    replies: z.number(),
  })
  .strict();

export const GroupPolicySchema = z
  .object({
    requireMention: z.boolean(),
    allowFrom: z.array(z.string()),
  })
  .strict();

export const AccessSchema = z
  .object({
    dmPolicy: z.enum(["pairing", "allowlist", "disabled"]).default("pairing"),
    allowFrom: z.array(z.string()).default([]),
    groups: z.record(GroupPolicySchema).default({}),
    pending: z.record(PendingEntrySchema).default({}),
    // delivery/UX config — optional, sama seperti kode acuan
    mentionPatterns: z.array(z.string()).optional(),
    ackReaction: z.string().optional(),
    replyToMode: z.enum(["off", "first", "all"]).optional(),
    textChunkLimit: z.number().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
  })
  .strict();

export type PendingEntry = z.infer<typeof PendingEntrySchema>;
export type GroupPolicy = z.infer<typeof GroupPolicySchema>;
export type Access = z.infer<typeof AccessSchema>;

/** Hasil `{}` lewat AccessSchema — dipakai saat baris (channel,bot_id) belum ada. */
export function defaultAccess(): Access {
  return AccessSchema.parse({});
}
