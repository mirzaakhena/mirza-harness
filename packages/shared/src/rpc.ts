import { z } from "zod";
import { MAX_HOP } from "./bus";
import { OutboundCommandSchema, ReplyFormatSchema, ReplySourceSchema } from "./outbound-command";
import { zodToJsonSchema, type JsonSchema } from "./json-schema";

/**
 * Task D2, Fase 1 — one source of truth (zod) for:
 *  (a) the 7 cc-stub MCP tool `inputSchema`s shown to the calling AI (kept
 *      surface-identical to the legacy plugins — `plugins/telegram/server.ts:572-654`
 *      for reply/react/download_attachment/get_message_by_id,
 *      `plugins/agent-bus/server.ts:56-108` for agent_list/agent_status/agent_send),
 *      converted to JSON Schema via `zodToJsonSchema` (json-schema.ts) so
 *      cc-stub never needs its own copy of the shape; and
 *  (b) the RPC `params` schemas hostd validates at the wire boundary for the
 *      new methods `telegram.outbound` / `agent.list` / `agent.status` /
 *      `agent.send` (constraint: "zod di boundary — letakkan skema di
 *      shared/src/rpc.ts").
 *
 * cc-stub's tools are thin proxies: it does NOT run these schemas itself
 * (no validation duplication) — it forwards raw tool arguments into an RPC
 * params object (adding `op`/`bot_id`/`from` as needed) and lets hostd's
 * rpc-handlers.ts be the one place that calls `.parse()`. A bad shape simply
 * surfaces as an RPC error, which cc-stub relays back as a tool error.
 */

// ---------------------------------------------------------------------------
// Buttons — MCP surface. `OutboundCommandSchema`'s `buttons` field in
// outbound-command.ts is deliberately shape-only (`z.array(z.unknown())`;
// deep validation happens at runtime in telegram-adapter's `validateButtons`).
// Review note C5: the MCP tool surface deserves an EXPLICIT schema (rows of
// {label, callback_id}) so the AI sees the real shape/constraints in
// `inputSchema`, aligned 1:1 with telegram-adapter/src/buttons.ts's rules
// (max 8 rows x 8 buttons, label <=64 chars, callback_id
// /^[a-z0-9_]{1,32}$/, globally unique). This schema is presentation +
// early-shape documentation only — `validateButtons()` in telegram-adapter
// remains the actual enforcement point when the reply is sent.
// ---------------------------------------------------------------------------

export const ButtonSpecSchema = z
  .object({
    label: z.string().min(1).max(64).describe("Visible button text. Max 64 chars."),
    callback_id: z
      .string()
      .regex(/^[a-z0-9_]{1,32}$/)
      .describe("Identifier echoed back to the AI when the user taps. Matches /^[a-z0-9_]{1,32}$/."),
  })
  .strict();

export const ButtonRowSchema = z.array(ButtonSpecSchema).min(1).max(8);

export const ButtonsSchema = z
  .array(ButtonRowSchema)
  .min(1)
  .max(8)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const row of rows) {
      for (const btn of row) {
        if (seen.has(btn.callback_id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate callback_id "${btn.callback_id}"` });
        }
        seen.add(btn.callback_id);
      }
    }
  })
  .describe(
    "Optional inline keyboard. Shape: rows of buttons, where each row is an array. Each button has {label, callback_id}. callback_id must match /^[a-z0-9_]{1,32}$/ and be unique across the call. Max 8 rows × 8 buttons. When tapped, a new <channel> message arrives with content \"[button tapped: <label>]\" and meta.callback_id.",
  );

// ---------------------------------------------------------------------------
// Telegram tool inputs (MCP surface) — reply/react/download_attachment/get_message_by_id.
// ---------------------------------------------------------------------------

export const ReplyToolInput = z
  .object({
    chat_id: z.string(),
    text: z.string(),
    reply_to: z.string().optional().describe("Message ID to thread under. Use message_id from the inbound <channel> block."),
    files: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach. Images send as photos (inline preview); other types as documents. Max 50MB each."),
    format: ReplyFormatSchema.optional().describe(
      "Rendering mode. 'markdown' (recommended) accepts standard CommonMark (`**bold**`, `*italic*`, `` ` ``inline``,  ```` ```fenced blocks```` ````, `[links](url)`) and auto-converts to Telegram MarkdownV2 — server handles all special-char escaping for you. 'markdownv2' is a raw passthrough; caller must escape `_*[]()~\\`>#+-=|{}.!` themselves (legacy). 'text' (default) sends plain text with no parsing.",
    ),
    source: ReplySourceSchema.optional().describe(
      "Origin of this reply. Default 'assistant' for direct user replies. Use 'system' when triggered by cronjob/scheduler/API event (not in response to a user message). Logged to messages-store.",
    ),
    buttons: ButtonsSchema.optional(),
  })
  .strict();

export const REPLY_TOOL_DESCRIPTION =
  "Reply on Telegram. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, files (absolute paths) to attach images or documents, and buttons to render an inline keyboard for the user to tap (one tap fires a callback that arrives as a new <channel> message). buttons cannot be combined with files in a single call.";

export const ReactToolInput = z
  .object({
    chat_id: z.string(),
    message_id: z.string(),
    emoji: z.string(),
  })
  .strict();

export const REACT_TOOL_DESCRIPTION =
  "Add an emoji reaction to a Telegram message. Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc) — non-whitelisted emoji will be rejected.";

export const DownloadAttachmentToolInput = z
  .object({
    file_id: z.string().describe("The attachment_file_id from inbound meta"),
  })
  .strict();

export const DOWNLOAD_ATTACHMENT_TOOL_DESCRIPTION =
  "Download a file attachment from a Telegram message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local file path ready to Read. Telegram caps bot downloads at 20MB.";

export const GetMessageByIdToolInput = z
  .object({
    chat_id: z.string().describe("Chat to look up in. Use chat_id from the inbound <channel> meta."),
    message_id: z.string().describe("Message ID to retrieve. Typically the reply_to value or an ID the user references."),
  })
  .strict();

export const GET_MESSAGE_BY_ID_TOOL_DESCRIPTION =
  'Look up a previously logged Telegram message by its (chat_id, message_id). Returns the stored row including text, source ("user" | "assistant" | "system"), parsed attachments (with local paths for photos — Read directly — and file_id for documents — use download_attachment), reply_to, and metadata (carries quote_text, media_group_id, message_ids for albums). Use when an inbound message references an older one — e.g. a reply quoting an image, or the user asks about something said earlier in this chat. Album items 2..N resolve via the album\'s first-item row. chat_id is required; never queries across chats. Throws when not found.';

// ---------------------------------------------------------------------------
// Agent-bus tool inputs (MCP surface) — agent_list/agent_status/agent_send.
// ---------------------------------------------------------------------------

export const AgentListToolInput = z.object({}).strict();

export const AGENT_LIST_TOOL_DESCRIPTION =
  "List all bots known to hostd (from its config). Returns each bot's name, workspace, poller status, and whether its cc-stub is currently connected. Safe to call autonomously at any time.";

export const AgentStatusToolInput = z
  .object({
    name: z.string().min(1).describe('Peer agent name (e.g. "bot-02")'),
  })
  .strict();

export const AGENT_STATUS_TOOL_DESCRIPTION =
  "Read a peer bot's status: workspace, telegram poller status, whether its cc-stub is connected, and its most recent session row (id/name/lifecycle) if one exists. Fase 1: hostd's `sessions` table has no writer yet, so `session` is null for every bot until the SessionStart hook (fase 2) starts recording — null means \"no data yet\", not an error. Safe to call autonomously.";

export const AgentSendPayloadSchema = z
  .object({
    kind: z.literal("prompt"),
    body: z
      .string()
      .refine((b) => Buffer.byteLength(b, "utf8") <= 8 * 1024, { message: "body exceeds 8 KB" })
      .describe("The natural-language instruction (max 8 KB)."),
    hop_count: z
      .number()
      .int()
      .min(0)
      .max(MAX_HOP)
      .optional()
      .describe(
        `Loop-prevention counter. Omit (= 0) for a fresh, user-initiated prompt. When replying because an inbound agent-bus prompt explicitly asked you to report back, pass the hop value named in that message PLUS ONE. Sends with hop_count > ${MAX_HOP} are refused.`,
      ),
  })
  .strict();

export const AgentSendToolInput = z
  .object({
    target: z
      .union([z.string(), z.array(z.string())])
      .describe("Target agent name, or an array of names for broadcast. Each must be registered."),
    payload: AgentSendPayloadSchema,
  })
  .strict();

export const AGENT_SEND_TOOL_DESCRIPTION =
  "Send a one-way natural-language prompt (kind=\"prompt\") to one or more peer bots. The body is delivered into the peer's Claude session as a channel notification and the peer's OWN AI decides how to act — including whether to refuse. One-way — there is NO reply channel. If you want the peer to report back, say so inside the body. `target` may be a single name or an array (broadcast/fan-out). DO NOT call autonomously — only when the user explicitly asks you to message another agent, OR when an inbound agent prompt explicitly told you to report back.";

// ---------------------------------------------------------------------------
// Generated JSON Schemas for the MCP `inputSchema` field — derived from the
// zod schemas above via `zodToJsonSchema`, so cc-stub's tool listing never
// hand-maintains a second copy of the shape.
// ---------------------------------------------------------------------------

export const ReplyToolJsonSchema: JsonSchema = zodToJsonSchema(ReplyToolInput);
export const ReactToolJsonSchema: JsonSchema = zodToJsonSchema(ReactToolInput);
export const DownloadAttachmentToolJsonSchema: JsonSchema = zodToJsonSchema(DownloadAttachmentToolInput);
export const GetMessageByIdToolJsonSchema: JsonSchema = zodToJsonSchema(GetMessageByIdToolInput);
export const AgentListToolJsonSchema: JsonSchema = zodToJsonSchema(AgentListToolInput);
export const AgentStatusToolJsonSchema: JsonSchema = zodToJsonSchema(AgentStatusToolInput);
export const AgentSendToolJsonSchema: JsonSchema = zodToJsonSchema(AgentSendToolInput);

// ---------------------------------------------------------------------------
// hostd RPC params — the wire contract cc-stub's `client.call(method, params)`
// actually sends, and what hostd's rpc-handlers.ts validates before acting.
// ---------------------------------------------------------------------------

/** `telegram.outbound` params: {bot_id, cmd}. `cmd` carries its own `op` discriminant (added by cc-stub, not part of any MCP tool input). */
export const TelegramOutboundParams = z
  .object({
    bot_id: z.string().min(1),
    cmd: OutboundCommandSchema,
  })
  .strict();

/** `agent.status` params. */
export const AgentStatusParams = z.object({ name: z.string().min(1) }).strict();

/**
 * `agent.send` params. Unlike `AgentSendToolInput` (the MCP surface, which
 * never asks the AI for `from` — that would let a caller spoof another
 * bot's identity), this RPC-level schema carries `from` because cc-stub
 * itself fills it in from its own resolved bot_id before the call.
 */
export const AgentSendParams = z
  .object({
    from: z.string().min(1).optional(),
    target: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    payload: AgentSendPayloadSchema,
  })
  .strict();

export type ButtonSpecT = z.infer<typeof ButtonSpecSchema>;
export type ReplyToolInputT = z.infer<typeof ReplyToolInput>;
export type ReactToolInputT = z.infer<typeof ReactToolInput>;
export type DownloadAttachmentToolInputT = z.infer<typeof DownloadAttachmentToolInput>;
export type GetMessageByIdToolInputT = z.infer<typeof GetMessageByIdToolInput>;
export type AgentStatusToolInputT = z.infer<typeof AgentStatusToolInput>;
export type AgentSendToolInputT = z.infer<typeof AgentSendToolInput>;
export type AgentSendPayloadT = z.infer<typeof AgentSendPayloadSchema>;
export type TelegramOutboundParamsT = z.infer<typeof TelegramOutboundParams>;
export type AgentStatusParamsT = z.infer<typeof AgentStatusParams>;
export type AgentSendParamsT = z.infer<typeof AgentSendParams>;
