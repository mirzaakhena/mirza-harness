import { randomUUID } from "node:crypto";
import { Envelope, type Access, type EnvelopeT } from "@mirza-harness/shared";
import { gate, type ChatType, type GateResult } from "./gate";
import { parseAiCallbackData } from "./buttons";
import { createAlbumBuffer } from "./album-buffer";
import {
  tryRouteMetaCommand,
  tryHandleMetaCallback,
  type MetaCommandBot,
  type SessionOpsClient,
  type MetaCommandResult,
  type MetaCallbackEffect,
} from "./meta-commands";

/**
 * Task C4, Fase 1 — inbound pipeline: gate (C2) -> media/album/quote/callback
 * -> messages-store -> bus enqueue. Ported from `handleInbound` /
 * `handleInboundAlbum` / the `ai:*` callback branch,
 * `plugins/telegram/server.ts:1333-1951` (mirza-marketplace, kode acuan) —
 * see `.superpowers/sdd/f1/task-C4-brief.md`.
 *
 * Deliberately NOT grammy: this module takes a normalized `InboundMessage`,
 * never a grammy `Context`. Wiring a real `Context` into `InboundMessage` —
 * downloading photos, resolving the tapped button's label, deciding
 * `isInfoCommand` for group mentions — is the assembly layer's job, not
 * this pipeline's. That keeps `handleInbound` a pure(ish) async function:
 * every side effect (store write, bus enqueue, file download, pending
 * persistence) comes in through an injected dependency, so tests never touch
 * a real Telegram/SQLite/filesystem.
 *
 * Deviations from kode acuan (all deliberate, documented at the call site
 * below):
 * - Callback taps (`ai:*`) ARE persisted to `store.logInbound` here. Kode
 *   acuan's callback branch only calls `mcp.notification`, never
 *   `messagesStore.logInbound` — but this pipeline funnels every `deliver`
 *   outcome (text/photo/document/album/callback) through the same
 *   store-then-enqueue path so the messages table stays a complete audit
 *   trail of "how anything gets to the AI", not just plain chat text.
 * - Pairing-reply is DATA, not a side effect: kode acuan does
 *   `ctx.reply(...)` directly. Here, `{type:'pairing-reply', text, code}` is
 *   returned to the caller (sync path) and also handed to the optional
 *   `onPairingReply` hook (async album-flush path has no caller promise to
 *   resolve into). Sending the actual Telegram message is out of scope
 *   (outbound is a different task).
 * - `onPending` is only invoked when `isResend === false` (a genuinely new
 *   code). Calling access-store's `addPending` again for a resend would
 *   overwrite the existing pending entry (createdAt/expiresAt/replies all
 *   reset) and undermine the reply-cap check in `gate.ts`'s `pairingFlow`.
 * - Meta-commands (Task M1, Fase 2) ARE now intercepted BEFORE delivery to
 *   the AI, via the optional `metaCommands` dependency (`{ bot, client }`,
 *   `client: SessionOpsClient` from `./meta-commands.ts`, itself a thin
 *   router over hostd's session-ops supervisor API — see that module's doc
 *   for the full recon-meta.md mapping). `isMetaCommand` (computed via
 *   `isKnownMetaCommand`) still gates through SEC-2 in `gate()` first — a
 *   meta-command only ever reaches `tryRouteMetaCommand`/
 *   `tryHandleMetaCallback` when `chatType==='private' && sender in
 *   allowFrom`; the meta: callback path passes `isMetaCommand:true` into
 *   `gate()` for the same reason (a crafted `meta:*` callback_data must not
 *   slip through group/mention rules). When `metaCommands` is NOT supplied
 *   (older/partial wiring — hostd's `main.ts` doesn't pass it yet as of
 *   Fase 2 M1; that's a separate wiring task) the pipeline falls back to
 *   the Fase-1 behavior: a recognized meta-command text still delivers to
 *   the AI with `meta.note = 'meta-command-unhandled-fase1'` stamped, and a
 *   `meta:*` callback is dropped outright (out of scope without a client).
 *   `isPermissionReply` is never computed here (always false) — that whole
 *   flow remains out of scope.
 * - `isInfoCommand` (SEC-1 in gate.ts — /start /help /context /version are
 *   DM-only) IS computed before every `gate()` call, via `isKnownInfoCommand`
 *   mirroring the four `bot.command(...)` handlers gated by `dmCommandGate`
 *   in kode acuan (`server.ts:1011-1114`). Without this, gate.ts's DM-only
 *   invariant for info commands is unreachable — the flag would always be
 *   `undefined`/falsy and a group message could slip past it.
 */

// ---------------------------------------------------------------------------
// Normalized inbound message shape (assembly builds this from a grammy ctx).
// ---------------------------------------------------------------------------

export interface InboundQuote {
  text: string;
  isManual: boolean;
}

export interface InboundPhoto {
  /** Telegram file_id of the best-resolution photo. */
  fileId: string;
}

export interface InboundDocument {
  fileId: string;
  size?: number;
  mime?: string;
  name?: string;
}

export interface InboundCallback {
  /** Raw callback_data, e.g. "ai:abc123". */
  data: string;
  /** Human-readable label of the tapped button, if the caller could resolve it from the keyboard. */
  buttonLabel?: string;
}

export interface InboundMessage {
  chatType: ChatType;
  chatId: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  text?: string;
  photo?: InboundPhoto;
  document?: InboundDocument;
  quote?: InboundQuote;
  /** Present when this message is part of a Telegram album (SCAR-055). */
  mediaGroupId?: string;
  callback?: InboundCallback;
  /** Epoch ms of the original message. Falls back to `now()` when absent. */
  ts?: number;
  /** message_id of `reply_to_message`, if this message is a reply. Kode acuan logs this even when the quote text extraction yields nothing (e.g. reply to a photo with no caption) — see `store.logInbound`'s `reply_to`. */
  replyToMessageId?: string;
}

// ---------------------------------------------------------------------------
// Injected dependencies.
// ---------------------------------------------------------------------------

/** Structural subset of hostd's `MessagesStore.logInbound` — no import from `@mirza-harness/hostd` (wrong dependency direction). */
export interface InboundStoreLike {
  logInbound(input: {
    ts: number;
    chat_id: string;
    message_id?: string;
    user_id?: string;
    user_name?: string;
    body?: string;
    attachments?: unknown[];
    reply_to?: string;
    metadata?: Record<string, unknown>;
    quote_text?: string;
    quote_is_manual?: boolean;
  }): void;
}

export interface PairingReplyResult {
  text: string;
  code: string;
  isResend: boolean;
}

export type InboundOutcome =
  | { type: "dropped"; reason: string }
  | { type: "delivered" }
  | ({ type: "pairing-reply" } & PairingReplyResult)
  | { type: "buffered" }
  | { type: "meta-command"; result: MetaCommandResult }
  | { type: "meta-callback"; effects: MetaCallbackEffect[] };

/** Task M1 (Fase 2) dependency — routes intercepted meta-commands/callbacks to hostd's session-ops supervisor. */
export interface MetaCommandsConfig {
  bot: MetaCommandBot;
  client: SessionOpsClient;
}

export interface CreateInboundPipelineOptions {
  botId: string;
  access: () => Access;
  store: InboundStoreLike;
  /** Sink for the fully-built envelope (e.g. `(env) => enqueue(db, env)`). */
  enqueueEnv: (env: EnvelopeT) => void;
  /** Resolve a Telegram file_id to a local path. Default: always undefined (no download capability). */
  downloadFile?: (fileId: string) => Promise<string | undefined>;
  /** Injectable clock (ms) — default `Date.now`. */
  now?: () => number;
  /** Persist a fresh pairing code (access-store's `addPending`-like callback). Only called when isResend === false. */
  onPending?: (userId: string, code: string) => void;
  /** Observe a pairing-reply outcome regardless of path (sync message or async album flush). */
  onPairingReply?: (chatId: string, result: PairingReplyResult) => void;
  /** Observe the outcome of an album flush (no caller promise exists to resolve into for that async path). */
  onAlbumOutcome?: (chatId: string, outcome: InboundOutcome) => void;
  /**
   * Task M1 (Fase 2) — when supplied, a recognized meta-command (`/new`,
   * `/switch`, `/delete[...]`, `/rename`, `/effort`) or a `meta:*` callback
   * is intercepted BEFORE delivery to the AI: routed through
   * `tryRouteMetaCommand`/`tryHandleMetaCallback` (./meta-commands.ts)
   * against this `client`, and the resulting `MetaCommandResult`/
   * `MetaCallbackEffect[]` is returned as the outcome for the caller to
   * send (this pipeline never sends Telegram messages itself). When
   * omitted, falls back to the Fase-1 behavior (see module doc).
   */
  metaCommands?: MetaCommandsConfig;
}

interface ResolvedDeps {
  botId: string;
  access: () => Access;
  store: InboundStoreLike;
  enqueueEnv: (env: EnvelopeT) => void;
  downloadFile: (fileId: string) => Promise<string | undefined>;
  now: () => number;
  onPending: (userId: string, code: string) => void;
  onPairingReply: (chatId: string, result: PairingReplyResult) => void;
  onAlbumOutcome: (chatId: string, outcome: InboundOutcome) => void;
  metaCommands?: MetaCommandsConfig;
}

function warn(stage: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`telegram-adapter: inbound ${stage} failed: ${msg}\n`);
}

/** True when `lower` (already trimmed+lowercased) IS `cmd`, or `cmd` followed by a space — never a loose prefix (`\b` would wrongly match `/new-onboarding` against `/new`). */
function isCommandMatch(lower: string, cmd: string): boolean {
  return lower === cmd || lower.startsWith(`${cmd} `);
}

/** Mirrors the known meta-command prefixes in `meta-commands.ts` (mirza-marketplace) — see module doc. */
const META_COMMANDS = ["/new", "/switch", "/delete", "/rename", "/effort"];

function isKnownMetaCommand(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  return META_COMMANDS.some(cmd => isCommandMatch(lower, cmd));
}

/**
 * Info-command class per gate.ts's SEC-1 (`isInfoCommand`) — mirrors the four
 * `bot.command(...)` handlers gated by `dmCommandGate` in kode acuan
 * (`plugins/telegram/server.ts:1011-1114`: /start /help /context /version).
 * All four are DM-only; the pipeline must compute this flag before every
 * `gate()` call so gate.ts's DM-only invariant for info commands actually
 * takes effect (previously never set, so it was silently always false).
 */
const INFO_COMMANDS = ["/start", "/help", "/context", "/version"];

function isKnownInfoCommand(text: string | undefined): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  return INFO_COMMANDS.some(cmd => isCommandMatch(lower, cmd));
}

function pairingReplyText(result: Extract<GateResult, { action: "pairing-reply" }>): string {
  const lead = result.isResend ? "Still pending" : "Pairing required";
  return `${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`;
}

function buildAttachmentsForLog(
  imagePath: string | undefined,
  doc: InboundDocument | undefined,
): Record<string, unknown>[] | undefined {
  const out: Record<string, unknown>[] = [];
  if (imagePath) out.push({ type: "photo", path: imagePath });
  if (doc) out.push(documentLogEntry(doc));
  return out.length > 0 ? out : undefined;
}

function documentLogEntry(doc: InboundDocument): Record<string, unknown> {
  return {
    type: "document",
    file_id: doc.fileId,
    ...(doc.size != null ? { size: doc.size } : {}),
    ...(doc.mime ? { mime: doc.mime } : {}),
    ...(doc.name ? { name: doc.name } : {}),
  };
}

function enqueueFull(deps: ResolvedDeps, payload: { content: string; meta: Record<string, string> }): void {
  const env: EnvelopeT = Envelope.parse({
    id: randomUUID(),
    ts: Math.floor(deps.now() / 1000),
    from: "telegram",
    to: deps.botId,
    kind: "channel-inbound",
    payload,
    hop: 0,
  });
  deps.enqueueEnv(env);
}

// ---------------------------------------------------------------------------
// Single (non-album) message path — text, single photo, single document,
// or an ai:* callback tap.
// ---------------------------------------------------------------------------

async function handleSingle(msg: InboundMessage, deps: ResolvedDeps): Promise<InboundOutcome> {
  const isMetaCommand = isKnownMetaCommand(msg.text);
  const isInfoCommand = isKnownInfoCommand(msg.text);
  const gateResult = gate(
    {
      chatType: msg.chatType,
      chatId: msg.chatId,
      senderId: msg.senderId,
      text: msg.text,
      isMetaCommand,
      isInfoCommand,
    },
    deps.access(),
    { now: deps.now() },
  );

  if (gateResult.action === "drop") {
    return { type: "dropped", reason: gateResult.reason };
  }
  if (gateResult.action === "pairing-reply") {
    return finishPairingReply(gateResult, msg.senderId, msg.chatId, deps);
  }

  const ts = msg.ts ?? deps.now();

  if (isMetaCommand && deps.metaCommands) {
    const result = await tryRouteMetaCommand(msg.text ?? "", deps.metaCommands.bot, deps.metaCommands.client);
    if (result) {
      deps.store.logInbound({
        ts,
        chat_id: msg.chatId,
        message_id: msg.messageId,
        user_id: msg.senderId,
        user_name: msg.senderName ?? msg.senderId,
        body: msg.text,
        metadata: { meta_command: true },
      });
      return { type: "meta-command", result };
    }
  }

  const imagePath = msg.photo ? await safeDownload(msg.photo.fileId, deps) : undefined;

  const content = msg.text ?? (msg.photo ? "(photo)" : msg.document ? `(document: ${msg.document.name ?? "file"})` : "");

  deps.store.logInbound({
    ts,
    chat_id: msg.chatId,
    message_id: msg.messageId,
    user_id: msg.senderId,
    user_name: msg.senderName ?? msg.senderId,
    body: content || undefined,
    attachments: buildAttachmentsForLog(imagePath, msg.document),
    reply_to: msg.replyToMessageId,
    quote_text: msg.quote?.text,
    quote_is_manual: msg.quote != null ? msg.quote.isManual : undefined,
  });

  const meta: Record<string, string> = {
    chat_id: msg.chatId,
    message_id: msg.messageId,
    user: msg.senderName ?? msg.senderId,
    user_id: msg.senderId,
    ts: new Date(ts).toISOString(),
    ...(imagePath ? { image_path: imagePath } : {}),
    ...(msg.quote
      ? { quote_text: msg.quote.text, quote_is_manual: msg.quote.isManual ? "true" : "false" }
      : {}),
    ...(msg.document
      ? {
          attachment_kind: "document",
          attachment_file_id: msg.document.fileId,
          ...(msg.document.size != null ? { attachment_size: String(msg.document.size) } : {}),
          ...(msg.document.mime ? { attachment_mime: msg.document.mime } : {}),
          ...(msg.document.name ? { attachment_name: msg.document.name } : {}),
        }
      : {}),
    ...(isMetaCommand ? { note: "meta-command-unhandled-fase1" } : {}),
  };

  enqueueFull(deps, { content, meta });
  return { type: "delivered" };
}

async function safeDownload(fileId: string, deps: ResolvedDeps): Promise<string | undefined> {
  try {
    return await deps.downloadFile(fileId);
  } catch (err) {
    warn("photo download", err);
    return undefined;
  }
}

function finishPairingReply(
  gateResult: Extract<GateResult, { action: "pairing-reply" }>,
  senderId: string,
  chatId: string,
  deps: ResolvedDeps,
): InboundOutcome {
  const text = pairingReplyText(gateResult);
  if (!gateResult.isResend) deps.onPending(senderId, gateResult.code);
  const result: PairingReplyResult = { text, code: gateResult.code, isResend: gateResult.isResend };
  deps.onPairingReply(chatId, result);
  return { type: "pairing-reply", ...result };
}

// ---------------------------------------------------------------------------
// Callback (ai:* button tap) path.
// ---------------------------------------------------------------------------

/**
 * meta:* callback branch (Task M1, Fase 2). Split out of `handleCallback`
 * so the ai:* path below stays untouched. `isMetaCommand:true` is passed
 * into `gate()` here (SEC-2) so a crafted `meta:*` callback_data can never
 * slip through group/mention rules the way a plain ai:* button tap can —
 * meta: callbacks require chatType==='private' && sender in allowFrom, full
 * stop, exactly like meta-command TEXT does in `handleSingle`.
 */
async function handleMetaCallback(
  callback: InboundCallback,
  msg: InboundMessage,
  deps: ResolvedDeps,
): Promise<InboundOutcome> {
  const gateResult = gate(
    {
      chatType: msg.chatType,
      chatId: msg.chatId,
      senderId: msg.senderId,
      isInfoCommand: isKnownInfoCommand(msg.text),
      isMetaCommand: true,
    },
    deps.access(),
    { now: deps.now() },
  );

  if (gateResult.action === "drop") {
    return { type: "dropped", reason: gateResult.reason };
  }
  if (gateResult.action === "pairing-reply") {
    return finishPairingReply(gateResult, msg.senderId, msg.chatId, deps);
  }

  if (!deps.metaCommands) {
    return { type: "dropped", reason: "meta callback but no SessionOps client wired" };
  }

  const effects = await tryHandleMetaCallback(callback.data, deps.metaCommands.bot, deps.metaCommands.client);
  if (!effects) {
    return { type: "dropped", reason: "not a meta callback" };
  }

  const ts = msg.ts ?? deps.now();
  deps.store.logInbound({
    ts,
    chat_id: msg.chatId,
    message_id: msg.messageId,
    user_id: msg.senderId,
    user_name: msg.senderName ?? msg.senderId,
    body: `[meta callback: ${callback.data}]`,
    metadata: { meta_callback: true },
  });
  return { type: "meta-callback", effects };
}

async function handleCallback(msg: InboundMessage, deps: ResolvedDeps): Promise<InboundOutcome> {
  const callback = msg.callback;
  if (!callback) {
    warn("callback", "missing callback payload on a message routed as callback");
    return { type: "dropped", reason: "missing callback payload" };
  }

  if (callback.data.startsWith("meta:")) {
    return handleMetaCallback(callback, msg, deps);
  }

  // perm:* callbacks are handled by other (future) consumers — this
  // pipeline only speaks the ai:* namespace (buttons.ts, C1) plus meta:*
  // (handled above).
  const aiParsed = parseAiCallbackData(callback.data);
  if (!aiParsed) {
    return { type: "dropped", reason: "callback not in ai:* namespace (out of Fase-1 scope)" };
  }

  const gateResult = gate(
    { chatType: msg.chatType, chatId: msg.chatId, senderId: msg.senderId, isInfoCommand: isKnownInfoCommand(msg.text) },
    deps.access(),
    { now: deps.now() },
  );

  if (gateResult.action === "drop") {
    return { type: "dropped", reason: gateResult.reason };
  }
  if (gateResult.action === "pairing-reply") {
    return finishPairingReply(gateResult, msg.senderId, msg.chatId, deps);
  }

  const ts = msg.ts ?? deps.now();
  const label = callback.buttonLabel;
  const content = label ? `[button tapped: ${label}]` : "[button tapped]";

  deps.store.logInbound({
    ts,
    chat_id: msg.chatId,
    message_id: msg.messageId,
    user_id: msg.senderId,
    user_name: msg.senderName ?? msg.senderId,
    body: content,
    metadata: { callback_id: aiParsed.callback_id },
  });

  const meta: Record<string, string> = {
    chat_id: msg.chatId,
    callback_id: aiParsed.callback_id,
    ...(label ? { button_label: label } : {}),
    ...(msg.messageId ? { source_message_id: msg.messageId } : {}),
    user: msg.senderName ?? msg.senderId,
    user_id: msg.senderId,
    ts: new Date(ts).toISOString(),
  };

  enqueueFull(deps, { content, meta });
  return { type: "delivered" };
}

// ---------------------------------------------------------------------------
// Album flush path (SCAR-055 / SCAR-056).
// ---------------------------------------------------------------------------

async function flushAlbum(key: string, items: InboundMessage[], deps: ResolvedDeps): Promise<void> {
  if (items.length === 0) return; // FUNC-1 guard — should be unreachable (album-buffer never flushes empty buckets).

  // Telegram doesn't guarantee album parts arrive in send order — sort by
  // message_id ASC so image_paths / Photo-N labels match what the user saw.
  const sorted = [...items].sort((a, b) => Number(a.messageId) - Number(b.messageId));
  const first = sorted[0]!;
  const colonIdx = key.indexOf(":");
  const mediaGroupId = colonIdx >= 0 ? key.slice(colonIdx + 1) : key;

  const gateResult = gate(
    { chatType: first.chatType, chatId: first.chatId, senderId: first.senderId, isInfoCommand: isKnownInfoCommand(first.text) },
    deps.access(),
    { now: deps.now() },
  );

  if (gateResult.action === "drop") {
    deps.onAlbumOutcome(first.chatId, { type: "dropped", reason: gateResult.reason });
    return;
  }
  if (gateResult.action === "pairing-reply") {
    const outcome = finishPairingReply(gateResult, first.senderId, first.chatId, deps);
    deps.onAlbumOutcome(first.chatId, outcome);
    return;
  }

  const ts = first.ts ?? deps.now();

  type Downloaded =
    | { kind: "photo"; path: string | undefined }
    | { kind: "document"; doc: InboundDocument }
    | { kind: "none" };

  const settled = await Promise.allSettled(
    sorted.map(async (item): Promise<Downloaded> => {
      if (item.photo) return { kind: "photo", path: await safeDownload(item.photo.fileId, deps) };
      if (item.document) return { kind: "document", doc: item.document };
      return { kind: "none" };
    }),
  );

  const imagePaths: string[] = [];
  const logAttachments: Record<string, unknown>[] = [];
  const notifAttachments: Record<string, unknown>[] = [];
  let failedCount = 0;

  settled.forEach((s, idx) => {
    if (s.status === "rejected") {
      failedCount++;
      warn(`album item ${idx + 1}/${sorted.length}`, s.reason);
      return;
    }
    const v = s.value;
    if (v.kind === "photo") {
      if (!v.path) {
        failedCount++;
        return;
      }
      imagePaths.push(v.path);
      logAttachments.push({ type: "photo", path: v.path });
    } else if (v.kind === "document") {
      const entry = documentLogEntry(v.doc);
      logAttachments.push(entry);
      notifAttachments.push(entry);
    } else {
      // Defensive: neither photo nor document — FUNC-1, never crash.
      failedCount++;
    }
  });

  const successCount = imagePaths.length + notifAttachments.length;
  if (successCount === 0) {
    deps.onAlbumOutcome(first.chatId, { type: "dropped", reason: "all album items failed to load" });
    return;
  }

  const captionsWithIndex = sorted
    .map((it, idx) => ({ idx, caption: it.text?.trim() ?? "" }))
    .filter(c => c.caption.length > 0);
  let combinedCaption: string;
  if (captionsWithIndex.length === 0) {
    combinedCaption = `(album of ${sorted.length} items)`;
  } else if (captionsWithIndex.length === 1) {
    combinedCaption = captionsWithIndex[0]!.caption;
  } else {
    combinedCaption = captionsWithIndex.map(c => `Photo ${c.idx + 1}: ${c.caption}`).join("\n");
  }
  if (failedCount > 0) {
    combinedCaption = `${combinedCaption}\n\n[warning: ${failedCount} of ${sorted.length} items failed to load]`;
  }

  // Per kode acuan: an album reply-quote only ever lands on the first part —
  // quote comes from `first`, never from later items (SCAR-055).
  const quote = first.quote;
  const messageIds = sorted.map(i => i.messageId);

  deps.store.logInbound({
    ts,
    chat_id: first.chatId,
    message_id: first.messageId,
    user_id: first.senderId,
    user_name: first.senderName ?? first.senderId,
    body: combinedCaption,
    attachments: logAttachments.length > 0 ? logAttachments : undefined,
    reply_to: first.replyToMessageId,
    metadata: {
      media_group_id: mediaGroupId,
      message_ids: messageIds,
      ...(failedCount > 0 ? { failed_count: failedCount, total_count: sorted.length } : {}),
    },
    quote_text: quote?.text,
    quote_is_manual: quote != null ? quote.isManual : undefined,
  });

  // SCAR-056: meta must stay Record<string,string> — multi-value fields are
  // serialized as strings (newline-joined paths, comma-joined ids, JSON for
  // attachment objects), exactly like kode acuan L1786-1810.
  const meta: Record<string, string> = {
    chat_id: first.chatId,
    message_id: first.messageId,
    message_ids: messageIds.join(","),
    media_group_id: mediaGroupId,
    user: first.senderName ?? first.senderId,
    user_id: first.senderId,
    ts: new Date(ts).toISOString(),
    ...(imagePaths.length > 0 ? { image_paths: imagePaths.join("\n") } : {}),
    ...(quote ? { quote_text: quote.text, quote_is_manual: quote.isManual ? "true" : "false" } : {}),
    ...(notifAttachments.length > 0 ? { attachments: JSON.stringify(notifAttachments) } : {}),
  };

  enqueueFull(deps, { content: combinedCaption, meta });
  deps.onAlbumOutcome(first.chatId, { type: "delivered" });
}

// ---------------------------------------------------------------------------
// Public factory.
// ---------------------------------------------------------------------------

export type InboundHandler = (msg: InboundMessage | null | undefined) => Promise<InboundOutcome>;

/** debounceMs/hardCapMs/maxItems match kode acuan's albumBuffer exactly (server.ts:1455-1471). */
const ALBUM_DEBOUNCE_MS = 400;
const ALBUM_HARD_CAP_MS = 3000;
const ALBUM_MAX_ITEMS = 10;

export function createInboundPipeline(options: CreateInboundPipelineOptions): InboundHandler {
  const deps: ResolvedDeps = {
    botId: options.botId,
    access: options.access,
    store: options.store,
    enqueueEnv: options.enqueueEnv,
    downloadFile: options.downloadFile ?? (async () => undefined),
    now: options.now ?? Date.now,
    onPending: options.onPending ?? (() => {}),
    onPairingReply: options.onPairingReply ?? (() => {}),
    onAlbumOutcome: options.onAlbumOutcome ?? (() => {}),
    metaCommands: options.metaCommands,
  };

  const albumBuffer = createAlbumBuffer<InboundMessage>({
    debounceMs: ALBUM_DEBOUNCE_MS,
    hardCapMs: ALBUM_HARD_CAP_MS,
    maxItems: ALBUM_MAX_ITEMS,
    onFlush: (key, items) => flushAlbum(key, items, deps),
  });

  return async (msg: InboundMessage | null | undefined): Promise<InboundOutcome> => {
    // FUNC-1 guard: a null/undefined payload must never crash the pipeline.
    if (!msg) {
      warn("dispatch", "received null/undefined InboundMessage");
      return { type: "dropped", reason: "null payload" };
    }

    if (msg.mediaGroupId) {
      albumBuffer.add(`${msg.chatId}:${msg.mediaGroupId}`, msg);
      return { type: "buffered" };
    }

    if (msg.callback) {
      return handleCallback(msg, deps);
    }

    return handleSingle(msg, deps);
  };
}
