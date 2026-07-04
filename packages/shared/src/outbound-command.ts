import { z } from "zod";

/**
 * Zod discriminated union for the telegram-adapter outbound tool commands
 * (`reply` / `react` / `download_attachment` / `get_message_by_id`).
 *
 * Ported from the hand-rolled `parseOutboundCommand` that used to live in
 * `packages/telegram-adapter/src/outbound.ts` (Task C5 fix pass 1). That
 * parser existed only because `zod` was not a declared dependency of
 * telegram-adapter at the time; now that the project convention is "zod at
 * every boundary, schemas sourced from one place in shared", the shape/type/
 * required/enum checks live here and telegram-adapter imports the schema
 * (and its inferred types) instead of importing `zod` directly.
 *
 * Deliberately NOT covered here (stays runtime-context validation in
 * outbound.ts, same as before):
 *  - `buttons` deep shape (row/column caps, callback_id regex, label length,
 *    uniqueness) — handled by `validateButtons()`.
 *  - reaction emoji whitelist — handled by `REACTION_EMOJI_WHITELIST`.
 *  - file existence / size (50MB cap) — handled by `assertSendable` + `statSync`.
 *  - chat allowlist gate — handled by `assertAllowedChat`.
 * This schema only asserts: is `buttons` shaped like an array of rows (its
 * elements are opaque here), are the other fields the right primitive
 * type/enum, and are required fields present.
 */

export const ReplyFormatSchema = z.enum(["text", "markdown", "markdownv2"]);
export const ReplySourceSchema = z.enum(["assistant", "system"]);

export const ReplyCommandSchema = z
  .object({
    op: z.literal("reply"),
    chat_id: z.string(),
    text: z.string(),
    reply_to: z.string().optional(),
    files: z.array(z.string()).optional(),
    format: ReplyFormatSchema.optional(),
    source: ReplySourceSchema.optional(),
    /** Shape-checked here (array of rows); deep-validated by validateButtons(). */
    buttons: z.array(z.unknown()).optional(),
  })
  .strict();

export const ReactCommandSchema = z
  .object({
    op: z.literal("react"),
    chat_id: z.string(),
    message_id: z.string(),
    emoji: z.string(),
  })
  .strict();

export const DownloadAttachmentCommandSchema = z
  .object({
    op: z.literal("download_attachment"),
    file_id: z.string(),
  })
  .strict();

export const GetMessageByIdCommandSchema = z
  .object({
    op: z.literal("get_message_by_id"),
    chat_id: z.string(),
    message_id: z.string(),
  })
  .strict();

export const OutboundCommandSchema = z.discriminatedUnion("op", [
  ReplyCommandSchema,
  ReactCommandSchema,
  DownloadAttachmentCommandSchema,
  GetMessageByIdCommandSchema,
]);

export type ReplyFormat = z.infer<typeof ReplyFormatSchema>;
export type ReplySource = z.infer<typeof ReplySourceSchema>;
export type ReplyCommand = z.infer<typeof ReplyCommandSchema>;
export type ReactCommand = z.infer<typeof ReactCommandSchema>;
export type DownloadAttachmentCommand = z.infer<typeof DownloadAttachmentCommandSchema>;
export type GetMessageByIdCommand = z.infer<typeof GetMessageByIdCommandSchema>;
export type OutboundCommand = z.infer<typeof OutboundCommandSchema>;
