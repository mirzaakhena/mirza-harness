import type { Context } from "grammy";
import { findButtonLabel, type InboundMessage, type InboundDocument, type InboundPhoto, type InboundQuote } from "@mirza-harness/telegram-adapter";

/**
 * Task D2, Fase 1 assembly glue: grammy `Context` -> the normalized
 * `InboundMessage` that `@mirza-harness/telegram-adapter`'s
 * `createInboundPipeline` expects. Deliberately lives in hostd (not
 * telegram-adapter, which never imports grammy beyond re-exporting the
 * `Context` type) — same assembly/pure-module split already documented at
 * the top of telegram-adapter/src/inbound.ts.
 *
 * Two review notes from Task C4 applied here:
 *
 *  - (C4) Telegram's `message.date` (and the callback's originating
 *    message's `date`) is UNIX SECONDS; `InboundMessage.ts` is epoch
 *    MILLISECONDS. Every date read here is multiplied by 1000 — getting this
 *    wrong silently shows ~1970 timestamps downstream (messages-store,
 *    doctor, agent_status).
 *  - (C4) A command typed in a group carries a `@botname` suffix from
 *    Telegram clients (e.g. `/start@my_bot`) — inbound.ts's command matching
 *    (`isCommandMatch`) is an exact/prefix string compare and would never
 *    recognize `/start@my_bot` as `/start`. `stripBotMentionSuffix` strips
 *    ANY `@[A-Za-z0-9_]+` suffix off a leading command token unconditionally
 *    (not just this bot's own resolved username) — a deliberate
 *    simplification: this poller only ever receives updates addressed to
 *    ITS OWN bot token, so `/cmd@someothername` slipping through as a
 *    recognized meta/info command is a narrow, harmless edge case (worst
 *    case: an info command meant for a different bot in the same group also
 *    gets answered here), not worth threading the resolved `botUsername`
 *    through every call site to avoid.
 */

function stripBotMentionSuffix(text: string): string {
  return text.replace(/^(\/[a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1");
}

function bestPhoto(photos: ReadonlyArray<{ file_id: string }> | undefined): InboundPhoto | undefined {
  if (!photos || photos.length === 0) return undefined;
  // Telegram/grammy order PhotoSize smallest -> largest; the last entry is the best resolution.
  return { fileId: photos[photos.length - 1]!.file_id };
}

function mapDocument(doc: { file_id: string; file_size?: number; mime_type?: string; file_name?: string } | undefined): InboundDocument | undefined {
  if (!doc) return undefined;
  return {
    fileId: doc.file_id,
    ...(doc.file_size != null ? { size: doc.file_size } : {}),
    ...(doc.mime_type ? { mime: doc.mime_type } : {}),
    ...(doc.file_name ? { name: doc.file_name } : {}),
  };
}

interface QuoteSource {
  quote?: { text?: string; is_manual?: true };
  reply_to_message?: { text?: string; caption?: string };
}

/**
 * Port of `plugins/telegram/server-helpers.ts`'s `extractQuoteText` — same
 * precedence: manual partial-selection quote > full replied-message text >
 * replied-message caption > undefined.
 */
function extractQuote(message: QuoteSource | undefined): InboundQuote | undefined {
  if (!message) return undefined;
  const quoteText = message.quote?.text;
  if (quoteText && quoteText.length > 0) {
    return { text: quoteText, isManual: message.quote?.is_manual === true };
  }
  const replied = message.reply_to_message;
  if (replied?.text && replied.text.length > 0) return { text: replied.text, isManual: false };
  if (replied?.caption && replied.caption.length > 0) return { text: replied.caption, isManual: false };
  return undefined;
}

function mapMessage(ctx: Context): InboundMessage | undefined {
  const msg = ctx.message;
  if (!msg || !ctx.chat || !ctx.from) return undefined;

  const rawText = msg.text ?? msg.caption;
  const text = rawText != null ? stripBotMentionSuffix(rawText) : undefined;

  return {
    chatType: ctx.chat.type,
    chatId: String(ctx.chat.id),
    senderId: String(ctx.from.id),
    senderName: ctx.from.username ?? ctx.from.first_name,
    messageId: String(msg.message_id),
    text,
    photo: bestPhoto(msg.photo),
    document: mapDocument(msg.document),
    quote: extractQuote(msg as QuoteSource),
    mediaGroupId: msg.media_group_id,
    ts: msg.date != null ? msg.date * 1000 : undefined,
    replyToMessageId: msg.reply_to_message?.message_id != null ? String(msg.reply_to_message.message_id) : undefined,
  };
}

function mapCallbackQuery(ctx: Context): InboundMessage | undefined {
  const cq = ctx.callbackQuery;
  if (!cq || !cq.data || !ctx.chat || !ctx.from) return undefined;

  const msg = cq.message;
  const messageId = msg && "message_id" in msg ? String(msg.message_id) : undefined;
  const inlineKeyboard = msg && "reply_markup" in msg ? msg.reply_markup?.inline_keyboard : undefined;
  const buttonLabel = findButtonLabel(inlineKeyboard, cq.data);
  const dateS = msg && "date" in msg ? msg.date : undefined;

  return {
    chatType: ctx.chat.type,
    chatId: String(ctx.chat.id),
    senderId: String(ctx.from.id),
    senderName: ctx.from.username ?? ctx.from.first_name,
    // A callback tap always originates from a specific bot message; fall back to "0" only for the
    // (practically unreachable, per grammy's types) case where the originating message is unknown.
    messageId: messageId ?? "0",
    callback: { data: cq.data, ...(buttonLabel ? { buttonLabel } : {}) },
    ts: dateS != null ? dateS * 1000 : undefined,
  };
}

/**
 * Map a grammy `Context` (from telegram-adapter's poller `onInbound`) into
 * `InboundMessage`. Returns `undefined` for update shapes this pipeline
 * doesn't understand at Fase 1 (anything besides a text/photo/document
 * message or a button-tap callback query) — the caller (main.ts's
 * `onInbound` wiring) treats `undefined` as "nothing to do", mirroring kode
 * acuan only ever registering handlers for the update kinds it understands.
 */
export function mapCtxToInboundMessage(ctx: Context): InboundMessage | undefined {
  if (ctx.callbackQuery) return mapCallbackQuery(ctx);
  if (ctx.message) return mapMessage(ctx);
  return undefined;
}
