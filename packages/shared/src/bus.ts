import { z } from "zod";

/**
 * Max hop count for inter-agent envelopes (BUS-016..032 semantik lama
 * dipertahankan). Anti-loop guard: relay chain lebih dari ini ditolak di
 * titik enqueue, bukan silent-drop di penerima.
 */
export const MAX_HOP = 5;

/**
 * Envelope adalah unit terkecil bus-core: satu pesan dari satu agent ke
 * agent lain. `.strict()` supaya key tak dikenal ditolak sejak awal
 * (bukan ditelan diam-diam).
 */
export const Envelope = z.object({
  id: z.string().uuid(),
  ts: z.number(),
  from: z.string(),
  to: z.string(),
  kind: z.enum(["prompt", "channel-inbound", "outbound-send"]),
  payload: z.unknown(),
  hop: z.number().int().min(0).max(MAX_HOP),
  reply_to: z.string().optional(),
}).strict();

export type EnvelopeT = z.infer<typeof Envelope>;
