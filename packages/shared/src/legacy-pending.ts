import { z } from "zod";

/**
 * Zod schemas for `pending/*.json` — the filesystem IPC mailbox written by
 * mirza-marketplace's OLD pty-controller/agent-bus plugins (`writeCommand` /
 * `writeBatch` in `plugins/pty-controller/ipc.ts`, `writePromptToPending` in
 * `plugins/agent-bus/prompt-compose.ts`) and, historically, consumed by
 * `wrapper.ts`'s `consumePending`/`dispatchPayload` (mirza-marketplace,
 * `plugins/pty-controller/wrapper/src/wrapper.ts:987-1213`).
 *
 * Task X2 (Fase 2): hostd's `pending-consumer` shim (`packages/hostd/src/shim/
 * pending-consumer.ts`) becomes the peer-side reader of this mailbox while a
 * pilot bot is fronted by the new harness but the rest of the fleet still
 * runs the old wrapper. Per recon-hooks §D ("ambiguitas #2 — titik validasi
 * tunggal"), THIS module is now the single point of schema validation for
 * that mailbox — the old wrapper-side re-validation is retired for the pilot.
 *
 * Three (and only three) root shapes are recognized, matching the writers
 * above exactly:
 *  - a single slash command:  {id, ts, command, ...legacy optional fields}
 *  - a batch (JSON array root) of slash items: [{command, sessionName?,
 *    confirmAfterMs?}, ...] — `writeBatch` never puts an id/ts on the array
 *    root or on individual items; the pending file's own name (a UUID) is
 *    the closest stable identifier for the batch as a whole.
 *  - an agent-bus prompt: {id, ts, type:"prompt", from, text, hop_count}
 *
 * Anything else (unknown root shape, wrong field types, `type`/`kind` values
 * this phase doesn't implement yet such as "switch") fails validation — the
 * consumer quarantines the file rather than guessing. NOTE: `type:"switch"`
 * (session-switch) and `kind:"slash"`-with-`type` explicit variants are
 * deliberately NOT accepted here — that lands with S2 (session-ops API);
 * until then such files quarantine visibly rather than being silently
 * mis-handled.
 */

/** Legacy `sessionName`/`confirmAfterMs` extras kode acuan attaches to a single
 * slash-command payload (e.g. `/clear` with a name, `/effort` with a confirm
 * delay). This phase (X2) does not act on them yet — `enqueueInject` only
 * forwards bare command strings — but they must not cause a real, in-shape
 * file to be quarantined as "corrupt". */
const LegacyConfirmAfterMs = z.number().nonnegative();

/** Command string contract: must start with '/' — mirrors `validateBatch`'s
 * `o.command.startsWith('/')` check in `plugins/pty-controller/wrapper/src/
 * batch.ts`. */
const LegacySlashCommand = z.string().startsWith("/");

/** Max batch size — mirrors `MAX_BATCH_ITEMS` in `wrapper/src/batch.ts`. */
export const MAX_BATCH_ITEMS = 8;

export const LegacyBatchItemSchema = z
  .object({
    command: LegacySlashCommand,
    sessionName: z.string().optional(),
    confirmAfterMs: LegacyConfirmAfterMs.optional(),
  })
  .strict();

export const LegacyBatchPayloadSchema = z
  .array(LegacyBatchItemSchema)
  .min(1, "batch must contain at least one item")
  .max(MAX_BATCH_ITEMS, `batch too long (max ${MAX_BATCH_ITEMS})`);

export const LegacyCommandPayloadSchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().min(1),
    command: LegacySlashCommand,
    sessionName: z.string().optional(),
    confirmAfterMs: LegacyConfirmAfterMs.optional(),
    // Agent-bus extension fields — legal on any payload shape per kode
    // acuan's `consumePending` (checked before the type/kind branch), even
    // though a bare slash command rarely carries them in practice.
    from: z.string().optional(),
    hop_count: z.number().int().nonnegative().optional(),
    correlation_id: z.string().optional(),
  })
  .strict();

export const LegacyPromptPayloadSchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().min(1),
    type: z.literal("prompt"),
    from: z.string().min(1),
    text: z.string().min(1),
    hop_count: z.number().int().nonnegative().default(0),
    correlation_id: z.string().optional(),
  })
  .strict();

export type LegacyBatchItem = z.infer<typeof LegacyBatchItemSchema>;
export type LegacyCommandPayload = z.infer<typeof LegacyCommandPayloadSchema>;
export type LegacyPromptPayload = z.infer<typeof LegacyPromptPayloadSchema>;

export type LegacyPendingParseResult =
  | { ok: true; kind: "prompt"; payload: LegacyPromptPayload }
  | { ok: true; kind: "command"; payload: LegacyCommandPayload }
  | { ok: true; kind: "batch"; items: LegacyBatchItem[] }
  | { ok: false; error: string };

function formatZodError(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Single validation entry point for a parsed (already `JSON.parse`d)
 * `pending/*.json` body. Discriminates root shape (array = batch, `type
 * === "prompt"` = prompt, else = single command) and validates strictly
 * against the matching schema above. Never throws — callers get a tagged
 * result and decide what "invalid" means for them (quarantine, log, etc.).
 */
export function parseLegacyPending(raw: unknown): LegacyPendingParseResult {
  if (Array.isArray(raw)) {
    const r = LegacyBatchPayloadSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: formatZodError(r.error) };
    return { ok: true, kind: "batch", items: r.data };
  }

  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).type === "prompt") {
    const r = LegacyPromptPayloadSchema.safeParse(raw);
    if (!r.success) return { ok: false, error: formatZodError(r.error) };
    return { ok: true, kind: "prompt", payload: r.data };
  }

  const r = LegacyCommandPayloadSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: formatZodError(r.error) };
  return { ok: true, kind: "command", payload: r.data };
}
