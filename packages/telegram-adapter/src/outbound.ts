// Port of the `reply` / `react` / `download_attachment` / `get_message_by_id`
// MCP tool handlers, `plugins/telegram/server.ts:695-901` (mirza-marketplace,
// Task C5 brief). `edit_message` is NOT ported (design doc §10.5).
//
// Unlike the source (one giant MCP server module with module-scope `bot`,
// `TOKEN`, `STATE_DIR`, `messagesStore`), this is a pure factory:
// `createOutboundSender(opts)` takes every dependency as a parameter so it
// can be driven from a bus command (`kind:'outbound-send'`) instead of an
// MCP request, and tested without any network access.
//
// `OutboundCommand` shape/type/required/enum validation is a zod
// discriminated union sourced from `@mirza-harness/shared`
// (`outbound-command.ts`) — one schema, reused later by cc-stub (Task D2).
// `zod` itself is NOT imported directly here (per-package dependency
// isolation; only `@mirza-harness/shared` declares it) — only the schema and
// its inferred types cross the package boundary, hoisted transitively via
// shared. Validation that depends on runtime context rather than shape
// (button deep-shape, emoji whitelist, file existence/size, chat allowlist)
// stays here, unchanged.

import { InlineKeyboard, InputFile } from "grammy";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, join, sep } from "node:path";
import {
  OutboundCommandSchema,
  type Access,
  type DownloadAttachmentCommand,
  type GetMessageByIdCommand,
  type OutboundCommand,
  type ReactCommand,
  type ReplyCommand,
} from "@mirza-harness/shared";
import { buildKeyboard, validateButtons } from "./buttons";
import { MAX_CHUNK_LIMIT, planOutbound, type ChunkMode, type ReplyFormat } from "./chunk";

// ---------------------------------------------------------------------------
// Constants ported verbatim from the reference (server.ts:248-249,500).
// ---------------------------------------------------------------------------

/** SCAR-054: upload attachments are capped at 50MB (self-imposed; Telegram's own limit is higher). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** .jpg/.jpeg/.png/.gif/.webp go as photos (inline preview); everything else as documents. */
export const PHOTO_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/**
 * SCAR-053: Telegram's Bot API only accepts a fixed whitelist of reaction
 * emoji — anything outside this set is rejected by the API. List copied
 * verbatim from `plugins/telegram/ACCESS.md` (mirza-marketplace), the
 * "full Bot API list" the reference docs it against.
 */
export const REACTION_EMOJI_WHITELIST = new Set([
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩",
  "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭",
  "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈",
  "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗",
  "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊",
  "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡",
]);

// ---------------------------------------------------------------------------
// OutboundCommand — shape/type/required/enum validation lives in
// @mirza-harness/shared (outbound-command.ts) as a zod discriminated union;
// re-exported types kept here for call-site convenience.
// ---------------------------------------------------------------------------

export type { DownloadAttachmentCommand, GetMessageByIdCommand, OutboundCommand, ReactCommand, ReplyCommand };

/** Parse-or-throw entry point — throws `ZodError` on bad shape (see OutboundCommandSchema). */
export function parseOutboundCommand(raw: unknown): OutboundCommand {
  return OutboundCommandSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Injectable collaborators.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of grammy's `Bot.api` actually used here — declared
 * explicitly (rather than importing grammy's own `Api` type) so tests can
 * inject a pure in-memory fake with zero network access, mirroring the
 * pattern already used by `poller.ts`'s `PollerBot`.
 */
export interface OutboundApi {
  sendMessage(
    chat_id: string,
    text: string,
    other?: {
      reply_parameters?: { message_id: number };
      parse_mode?: "MarkdownV2";
      reply_markup?: InlineKeyboard;
    },
  ): Promise<{ message_id: number }>;
  sendPhoto(
    chat_id: string,
    photo: InputFile,
    other?: { reply_parameters?: { message_id: number } },
  ): Promise<{ message_id: number }>;
  sendDocument(
    chat_id: string,
    document: InputFile,
    other?: { reply_parameters?: { message_id: number } },
  ): Promise<{ message_id: number }>;
  setMessageReaction(
    chat_id: string,
    message_id: number,
    reaction: Array<{ type: "emoji"; emoji: string }>,
  ): Promise<unknown>;
  getFile(file_id: string): Promise<{ file_path?: string; file_unique_id?: string }>;
}

/**
 * Subset of hostd's `MessagesStore` (packages/hostd/src/state/messages-store.ts,
 * Task A2) actually used by the outbound sender. Declared locally — not
 * imported — because telegram-adapter must not depend on hostd (hostd
 * already depends on telegram-adapter; importing back would be a package
 * cycle). Any object satisfying this shape (in particular a real
 * `createMessagesStore(...)` instance) works.
 */
export interface OutboundStore {
  logOutbound(input: {
    ts: number;
    chat_id: string;
    message_id?: string;
    source: "assistant" | "system";
    body?: string;
    attachments?: unknown[];
    reply_to?: string;
    metadata?: Record<string, unknown>;
  }): void;
  getMessage(chat_id: string, message_id: string): unknown | null;
}

export interface CreateOutboundSenderOptions {
  botId: string;
  api: OutboundApi;
  store: OutboundStore;
  access: () => Access;
  /** Per-bot channel state dir — anti-exfil boundary for `files` (see assertSendable) and download target for download_attachment. */
  stateDir: string;
  /**
   * Bot token — needed to build the `https://api.telegram.org/file/bot<token>/<file_path>`
   * download URL (grammy's `getFile` response carries no URL, only `file_path`).
   * Not listed in the brief's abbreviated constructor signature but required
   * for `download_attachment` to actually work; kept separate from `api` so
   * `api` stays a plain send/receive surface.
   */
  token: string;
  /** Injectable fetch — default global `fetch`. Lets tests avoid real network. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for outbound log timestamps — default `Date.now`. */
  now?: () => number;
}

export interface OutboundSender {
  handle(cmd: unknown): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers ported from the reference.
// ---------------------------------------------------------------------------

/** Port of server.ts:315-320 — gate for reply/react (distinct from inbound gate.ts). */
function assertAllowedChat(chat_id: string, access: Access): void {
  if (access.allowFrom.includes(chat_id)) return;
  if (chat_id in access.groups) return;
  throw new Error(`chat ${chat_id} is not allowlisted`);
}

/**
 * Port of server.ts:255-265 (assertSendable) — anti-exfil: refuse to send any
 * file that resolves inside stateDir, UNLESS it's inside stateDir/inbox (the
 * one directory download_attachment writes to, which is fine to re-send).
 */
export function assertSendable(f: string, stateDir: string): void {
  let real: string;
  let stateReal: string;
  try {
    real = realpathSync(f);
    stateReal = realpathSync(stateDir);
  } catch {
    return; // statSync (caller) will fail properly; or stateDir absent -> nothing to leak
  }
  const inbox = join(stateReal, "inbox");
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`);
  }
}

/**
 * Duck-typed detection of Telegram's "can't parse entities" error (SCAR-048).
 * The reference checks `err instanceof GrammyError && /parse entities/i.test(err.description)`;
 * here we check for a `description` string instead of `instanceof GrammyError`
 * so the fallback also works against injected test doubles that aren't real
 * grammy errors (real `GrammyError` instances also carry `.description`, so
 * production behavior is unchanged).
 */
function isParseEntitiesError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "description" in err) {
    const d = (err as { description?: unknown }).description;
    return typeof d === "string" && /parse entities/i.test(d);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function createOutboundSender(opts: CreateOutboundSenderOptions): OutboundSender {
  const { api, store, access, stateDir, token } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  async function doReply(cmd: ReplyCommand): Promise<string> {
    const acc = access();
    assertAllowedChat(cmd.chat_id, acc);

    const files = cmd.files ?? [];

    let keyboard: InlineKeyboard | undefined;
    if (cmd.buttons !== undefined) {
      const v = validateButtons(cmd.buttons);
      if (!v.ok) throw new Error(`invalid buttons: ${v.error}`);
      // SCAR-062: buttons and files are mutually exclusive in a single reply call.
      if (files.length > 0) {
        throw new Error("buttons and files cannot be combined in a single reply call");
      }
      keyboard = buildKeyboard(v.rows);
    }

    for (const f of files) {
      assertSendable(f, stateDir);
      const st = statSync(f);
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`);
      }
    }

    const limit = Math.max(1, Math.min(acc.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT));
    const mode: ChunkMode = acc.chunkMode ?? "length";
    const replyMode = acc.replyToMode ?? "first";
    const format: ReplyFormat = cmd.format ?? "text";
    const source = cmd.source ?? "assistant";
    const reply_to = cmd.reply_to != null ? Number(cmd.reply_to) : undefined;

    const { parts, fallback } = planOutbound(cmd.text, format, limit, mode);

    const sentIds: number[] = [];
    const sentTexts: string[] = [];

    try {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const shouldReplyTo = reply_to != null && replyMode !== "off" && (replyMode === "all" || i === 0);
        // Buttons attach to the LAST chunk only — if attached to earlier
        // chunks, the keyboard sits orphaned above continuation text.
        const isLastChunk = i === parts.length - 1;
        const buildOpts = (mv2: boolean) => ({
          ...(shouldReplyTo ? { reply_parameters: { message_id: reply_to! } } : {}),
          ...(mv2 ? { parse_mode: "MarkdownV2" as const } : {}),
          ...(keyboard && isLastChunk ? { reply_markup: keyboard } : {}),
        });

        let sent: { message_id: number };
        try {
          sent = await api.sendMessage(cmd.chat_id, part.text, buildOpts(part.parse_mode === "MarkdownV2"));
          sentTexts.push(part.text);
        } catch (err) {
          // Last-resort degrade for format:'markdown': if Telegram still
          // refuses the entities, resend the raw CommonMark as plain text.
          const parseError = isParseEntitiesError(err);
          if (!(part.parse_mode === "MarkdownV2" && format === "markdown" && parseError)) throw err;
          const raw = fallback(part);
          sent = await api.sendMessage(cmd.chat_id, raw, buildOpts(false));
          sentTexts.push(raw);
        }
        sentIds.push(sent.message_id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`reply failed after ${sentIds.length} of ${parts.length} chunk(s) sent: ${msg}`);
    }

    // Files go as separate messages after all text chunks (Telegram doesn't
    // mix text+file in one sendMessage call).
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      const input = new InputFile(f);
      const fileOpts =
        reply_to != null && replyMode !== "off" ? { reply_parameters: { message_id: reply_to } } : undefined;
      const sent = PHOTO_EXTS.has(ext)
        ? await api.sendPhoto(cmd.chat_id, input, fileOpts)
        : await api.sendDocument(cmd.chat_id, input, fileOpts);
      sentIds.push(sent.message_id);
    }

    // Log every sent message: one row per text chunk + one row per file.
    const ts = now();
    for (let i = 0; i < parts.length; i++) {
      const chunkReplyTo =
        reply_to != null && replyMode !== "off" && (replyMode === "all" || i === 0)
          ? String(reply_to)
          : undefined;
      store.logOutbound({
        ts: ts + i,
        chat_id: cmd.chat_id,
        message_id: String(sentIds[i]),
        source,
        body: sentTexts[i],
        reply_to: chunkReplyTo,
        metadata: format !== "text" ? { format } : undefined,
      });
    }
    for (let j = 0; j < files.length; j++) {
      const f = files[j]!;
      const ext = extname(f).toLowerCase();
      const type = PHOTO_EXTS.has(ext) ? "photo" : "document";
      store.logOutbound({
        ts: ts + parts.length + j,
        chat_id: cmd.chat_id,
        message_id: String(sentIds[parts.length + j]),
        source,
        attachments: [{ type, path: f }],
      });
    }

    return sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts`;
  }

  async function doReact(cmd: ReactCommand): Promise<string> {
    assertAllowedChat(cmd.chat_id, access());
    if (!REACTION_EMOJI_WHITELIST.has(cmd.emoji)) {
      throw new Error(`emoji "${cmd.emoji}" is not in Telegram's reaction whitelist`);
    }
    await api.setMessageReaction(cmd.chat_id, Number(cmd.message_id), [
      { type: "emoji", emoji: cmd.emoji },
    ]);
    return "reacted";
  }

  async function doDownloadAttachment(cmd: DownloadAttachmentCommand): Promise<string> {
    const file = await api.getFile(cmd.file_id);
    if (!file.file_path) throw new Error("Telegram returned no file_path — file may have expired");
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // file_path is from Telegram (trusted), but strip to safe chars anyway so
    // nothing downstream can be tricked by an unexpected extension.
    const rawExt = file.file_path.includes(".") ? file.file_path.split(".").pop()! : "bin";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "") || "bin";
    const uniqueId = (file.file_unique_id ?? "").replace(/[^a-zA-Z0-9_-]/g, "") || "dl";
    const inboxDir = join(stateDir, "inbox");
    mkdirSync(inboxDir, { recursive: true });
    const path = join(inboxDir, `${now()}-${uniqueId}.${ext}`);
    writeFileSync(path, buf);
    return path;
  }

  function doGetMessageById(cmd: GetMessageByIdCommand): string {
    const row = store.getMessage(cmd.chat_id, cmd.message_id);
    if (!row) throw new Error(`no message ${cmd.message_id} in chat ${cmd.chat_id}`);
    return JSON.stringify(row, null, 2);
  }

  return {
    async handle(raw: unknown): Promise<string> {
      const cmd = parseOutboundCommand(raw);
      switch (cmd.op) {
        case "reply":
          return doReply(cmd);
        case "react":
          return doReact(cmd);
        case "download_attachment":
          return doDownloadAttachment(cmd);
        case "get_message_by_id":
          return doGetMessageById(cmd);
      }
    },
  };
}
