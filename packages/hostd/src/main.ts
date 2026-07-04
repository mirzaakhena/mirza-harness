import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type net from "node:net";
import type { Database } from "bun:sqlite";
import { Api, InlineKeyboard, type Context } from "grammy";
import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";
import {
  createInboundPipeline,
  createOutboundSender,
  gate,
  buildContextReply,
  buildVersionReply,
  createPackageJsonVersionQuery,
  type InboundOutcome,
  type InboundMessage,
  type OutboundApi,
  type OutboundSender,
  type SessionQuery,
  type SessionSnapshot,
  type VersionQuery,
  type MetaCommandButton,
  type MetaCommandResult,
  type MetaCallbackEffect,
} from "@mirza-harness/telegram-adapter";
import { HOSTD_VERSION } from "./doctor";
import { loadConfig, type BotConfig, type HostdConfig } from "./config";
import { openDb } from "./state/db";
import { createMessagesStore, type MessagesStore } from "./state/messages-store";
import { getAccess, addPending } from "./state/access-store";
import { enqueue } from "./bus/bus";
import { startDelivery, confirmDelivery, type DeliveryHandle } from "./bus/delivery";
import { startTelegramAdapters, type TelegramAdapterDeps, type TelegramAdaptersHandle } from "./adapters/telegram";
import { mapCtxToInboundMessage } from "./adapters/ctx-map";
import { startServer, pushEvent, isRegistered, registerConfirmHandler, registerRpcHandlerDeps, destroyAllConnections } from "./server";
import { startSupervisors, type SpawnHolderFn, type SupervisorsHandle } from "./supervisor/supervisor";
import { startPendingConsumer, type PendingConsumerHandle } from "./shim/pending-consumer";
import { createSessionOps, type SessionOps } from "./supervisor/session-ops";
import { createSessionOpsClient } from "./supervisor/session-ops-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/hostd/src -> packages/hostd/package.json (VER-1: read hostd's own version off disk, never hardcoded). */
const HOSTD_PKG_JSON = join(__dirname, "..", "package.json");
/** packages/hostd/src -> packages/pty-holder/package.json. */
const PTY_HOLDER_PKG_JSON = join(__dirname, "..", "..", "pty-holder", "package.json");

/**
 * Task D2, Fase 1 — production assembly: wires every module built across
 * Task A (state)/B (bus)/C (telegram-adapter)/D2 (rpc-handlers/cc-stub) into
 * one running hostd process.
 *
 * Wiring order matters:
 *  1. loadConfig — fail fast on a bad/missing config before touching the DB
 *     or network.
 *  2. openDb — schema + retention applied on open (state/db.ts).
 *  3. startServer(pipe) — accept cc-stub connections immediately so a stub
 *     that starts before hostd finishes booting doesn't spin on ECONNREFUSED
 *     longer than necessary.
 *  4. registerConfirmHandler / registerRpcHandlerDeps — wire server.ts's
 *     method table to real db/config/senders BEFORE startDelivery begins
 *     ticking (so the very first delivery tick already has a working
 *     confirm path) and before any cc-stub can call telegram.outbound/
 *     agent.*.
 *  5. startDelivery — bus -> cc-stub delivery loop.
 *  6. startTelegramAdapters — per-bot grammy pollers, each wired to a REAL
 *     `createInboundPipeline` (gate -> store -> bus enqueue), not the no-op
 *     default from Task C3.
 *
 * Per-bot outbound: one `grammy.Api` (a bare API client, NOT a polling
 * `Bot` — polling is the poller's job, this is only for sending/downloading)
 * and one `createOutboundSender` per configured bot, keyed by bot_id. The
 * SAME sender instance backs both `telegram.outbound` (cc-stub's reply/react/
 * download_attachment/get_message_by_id) AND the inbound pipeline's
 * `downloadFile` (reusing `sender.handle({op:'download_attachment', ...})` —
 * it has no allowlist gate of its own, only file_id, so it's safe to reuse
 * for inbound photo downloads that happen strictly after `gate()` already
 * approved delivery).
 *
 * Pairing-reply is the ONE outbound path that deliberately bypasses
 * `OutboundSender` (whose `reply` op enforces `assertAllowedChat` — the
 * sender is, by definition, NOT YET allowlisted when a pairing-reply fires).
 * It goes straight through the bot's raw `Api.sendMessage`, mirroring kode
 * acuan's direct `ctx.reply(...)` for this one system-generated message.
 */

interface BotWiring {
  config: BotConfig;
  api: Api;
  messagesStore: MessagesStore;
  sender: OutboundSender;
}

/** Fallback bound for shutdown()'s server.close() race — see the fix pass 1 (Bug 2) comment inside shutdown() below. */
const SHUTDOWN_CLOSE_TIMEOUT_MS = 3000;

function resolveDbPath(): string {
  const fromEnv = process.env.MIRZA_HOSTD_DB?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), "hostd.db");
}

/**
 * Adapt grammy's real `Api` client to telegram-adapter's `OutboundApi`
 * (modeled after grammy, but declared independently so telegram-adapter's
 * tests never need real grammy types — see outbound.ts's docstring). The
 * one genuine mismatch is `setMessageReaction`'s `emoji` parameter: grammy's
 * real type is a strict literal union of every whitelisted reaction emoji;
 * `OutboundApi` widens it to `string` since `REACTION_EMOJI_WHITELIST` is
 * already checked at runtime BEFORE this ever gets called (outbound.ts's
 * `doReact`) — the cast here is narrow (this one call only) and safe.
 */
function toOutboundApi(api: Api): OutboundApi {
  return {
    sendMessage: (chat_id, text, other) => api.sendMessage(chat_id, text, other),
    sendPhoto: (chat_id, photo, other) => api.sendPhoto(chat_id, photo, other),
    sendDocument: (chat_id, document, other) => api.sendDocument(chat_id, document, other),
    setMessageReaction: (chat_id, message_id, reaction) =>
      api.setMessageReaction(chat_id, message_id, reaction as Parameters<Api["setMessageReaction"]>[2]),
    getFile: file_id => api.getFile(file_id),
  };
}

/**
 * Fix E1-1: kode acuan (`plugins/telegram/server.ts:1277,1338,1381,1403,1409`)
 * calls `ctx.answerCallbackQuery(...)` for EVERY callback_query branch —
 * authorized (empty/plain ack) and unauthorized (`{text:'Not authorized.'}`)
 * alike — always `.catch(()=>{})`'d because a callback query expires ~15s
 * after Telegram sends it and answering a stale one throws. Fase-1 wiring
 * (`onInbound` below) called the pure `createInboundPipeline` but never
 * acked, so the button in the Telegram app spun forever even though the tap
 * reached the pipeline correctly.
 *
 * This stays in main.ts (wiring), not telegram-adapter's pipeline: the
 * pipeline is deliberately grammy-free (inbound.ts's module doc — "never a
 * grammy `Context`... this pipeline's" job stops at data), and it already
 * returns the `InboundOutcome` the ack decision needs (nothing new to plumb
 * through) — only the caller holds the live grammy `ctx` required to answer.
 *
 * Fix E1' (assembly review): the original ternary here (`outcome.type ===
 * "delivered" ? undefined : "Not authorized."`) mislabeled every OTHER
 * successful outcome as unauthorized too. `InboundOutcome`'s actual union is
 * `dropped | delivered | pairing-reply | buffered | meta-command |
 * meta-callback`; of these, only `meta-command` can never reach a callback
 * tap (it's text-only), and `meta-callback` is intercepted and fully handled
 * BEFORE this function is ever called (see `dispatchMetaCallbackEffects` +
 * `onInbound` below — a meta: tap acks with its own effect-specific text,
 * never the generic mapping here). So the only genuinely unauthorized/failed
 * outcome `ackCallback` itself ever needs to label is `dropped`; every other
 * outcome it might still see (`delivered`, `pairing-reply`, `buffered`) is a
 * legitimate, successfully-processed tap and acks silently (no text).
 */
async function ackCallback(ctx: Context, outcome: InboundOutcome): Promise<void> {
  const text = outcome.type === "dropped" ? "Not authorized." : undefined;
  try {
    await ctx.answerCallbackQuery(text ? { text } : undefined);
  } catch (err) {
    // Expected: callback queries expire ~15s after Telegram sends them.
    // Never let an expired-query error crash the inbound pipeline.
    process.stderr.write(`hostd: answerCallbackQuery gagal (kemungkinan callback query kadaluwarsa): ${err}\n`);
  }
}

// ---------------------------------------------------------------------------
// Task E1' (Fase 2 assembly) — /context, /version dispatch.
//
// Neither command is part of meta-commands.ts's routing set (`/new /switch
// /delete /rename /effort` — meta-commands.ts's own `isKnownMetaCommand` list
// in inbound.ts never includes them); they're SEC-1 "info commands"
// (isKnownInfoCommand in inbound.ts: /start /help /context /version). Since
// inbound.ts is off-limits for this task (already committed & tested) and has
// no hook of its own for "answer directly, don't forward to the AI", this
// wiring layer re-runs `gate()` itself with the SAME `isInfoCommand: true`
// flag BEFORE the real pipeline call: only on a genuine 'deliver' does it
// answer directly (bypassing the pipeline call entirely, so the text never
// also gets delivered to the AI as a normal message); on 'drop'/'pairing-reply'
// it does nothing and lets the caller fall through to the normal
// `pipeline(msg)` call, which independently recomputes the IDENTICAL gate()
// decision from the same inputs (pure function — deterministic) and handles
// drop/pairing-reply exactly like any other message.
// ---------------------------------------------------------------------------

function isContextOrVersionCommand(text: string | undefined): "context" | "version" | undefined {
  if (!text) return undefined;
  const lower = text.trim().toLowerCase();
  if (lower === "/context" || lower.startsWith("/context ") || lower.startsWith("/context\t")) return "context";
  if (lower === "/version" || lower.startsWith("/version ") || lower.startsWith("/version\t")) return "version";
  return undefined;
}

/** Production `SessionQuery` — reads the SAME `sessions` row `agent.status` (rpc-handlers.ts) reads (INFRA-5: one row, one writer, both readers agree by construction). */
function createDbSessionQuery(db: Database): SessionQuery {
  return {
    async getSession(botId: string): Promise<SessionSnapshot | null> {
      const row = db
        .query(
          `SELECT id, name, lifecycle, started_at, ended_at,
                  used_percentage, context_window_size, model, effort, cost, captured_at_ms
             FROM sessions
            WHERE bot_id = ?
            ORDER BY started_at DESC
            LIMIT 1`,
        )
        .get(botId) as SessionSnapshot | null;
      return row ?? null;
    },
  };
}

/**
 * Try to answer `/context` or `/version` directly. Returns `true` when
 * handled (caller must NOT also invoke the normal inbound pipeline for this
 * message) — `false` when it's not one of these two commands, or `gate()`
 * didn't say 'deliver' (caller falls through to the normal pipeline, which
 * re-derives the identical drop/pairing-reply outcome itself).
 */
async function tryAnswerInfoCommand(
  db: Database,
  botId: string,
  msg: InboundMessage,
  wiring: BotWiring,
  sessionQuery: SessionQuery,
  versionQuery: VersionQuery,
): Promise<boolean> {
  const kind = isContextOrVersionCommand(msg.text);
  if (!kind) return false;

  const access = getAccess(db, botId, "telegram");
  const gateResult = gate(
    { chatType: msg.chatType, chatId: msg.chatId, senderId: msg.senderId, text: msg.text, isInfoCommand: true },
    access,
    { now: Date.now() },
  );
  if (gateResult.action !== "deliver") return false;

  const text = kind === "version" ? await buildVersionReply(versionQuery) : await buildContextReply(botId, sessionQuery);
  try {
    await wiring.sender.handle({ op: "reply", chat_id: msg.chatId, text });
  } catch (err) {
    process.stderr.write(`hostd: gagal kirim /${kind} reply utk ${botId}/${msg.chatId}: ${err}\n`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Task E1' (Fase 2 assembly) — meta-command / meta-callback dispatch.
//
// `MetaCommandButton.callbackData` carries the FULL `meta:...` callback_data
// string verbatim (e.g. "meta:switch_abcd1234") — unlike `OutboundSender`'s
// `reply` op (whose buttons are ALWAYS re-prefixed `ai:` by
// telegram-adapter's `buildKeyboard`, for the ai:* namespace only), a meta
// picker's keyboard must NOT be re-prefixed or `tryHandleMetaCallback`'s
// `meta:` routing breaks. So — same rationale as the pairing-reply path
// above ("the ONE outbound path that deliberately bypasses OutboundSender")
// — meta output goes straight through the bot's raw grammy `Api`, building
// its own `InlineKeyboard` with each button's `callbackData` used as-is.
// ---------------------------------------------------------------------------

function buildMetaKeyboard(buttons: MetaCommandButton[][] | undefined): InlineKeyboard | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const kb = new InlineKeyboard();
  buttons.forEach((row, r) => {
    for (const btn of row) kb.text(btn.label, btn.callbackData);
    if (r < buttons.length - 1) kb.row();
  });
  return kb;
}

async function sendMetaMessage(wiring: BotWiring, chatId: string, text: string, buttons?: MetaCommandButton[][]): Promise<void> {
  const reply_markup = buildMetaKeyboard(buttons);
  await wiring.api.sendMessage(chatId, text, reply_markup ? { reply_markup } : undefined);
}

async function editMetaMessage(
  wiring: BotWiring,
  chatId: string,
  messageId: string,
  text: string,
  buttons?: MetaCommandButton[][],
): Promise<void> {
  const reply_markup = buildMetaKeyboard(buttons);
  await wiring.api.editMessageText(chatId, Number(messageId), text, reply_markup ? { reply_markup } : undefined);
}

/** A fresh `MetaCommandResult` message (from `/new /switch /delete /rename /effort`, or a meta-callback's `{kind:'reply'}` follow-up) — always a brand-new send. */
async function dispatchMetaCommandResult(wiring: BotWiring, chatId: string, result: MetaCommandResult): Promise<void> {
  try {
    await sendMetaMessage(wiring, chatId, result.text, result.buttons);
  } catch (err) {
    process.stderr.write(`hostd: gagal kirim meta-command reply utk ${wiring.config.id}/${chatId}: ${err}\n`);
  }
}

/**
 * Apply an ordered `MetaCallbackEffect[]` (from a `meta:*` button tap) — ack
 * the callback (its OWN text, e.g. "Cancelled"/"Confirmation required", never
 * the generic "Not authorized." `ackCallback` uses for a dropped tap), edit
 * the tapped message's text/keyboard, and/or send a brand-new follow-up
 * message (e.g. a confirm/cancel prompt). This is called INSTEAD of
 * `ackCallback` for a `meta-callback` outcome — see `onInbound` below. Effects
 * are applied strictly in order (ack always comes first in every branch
 * meta-commands.ts returns) and each is awaited before moving to the next —
 * a failure sending one effect (e.g. a slow/erroring edit) must never skip
 * the ack the Telegram button spinner is waiting on, nor vice versa.
 */
async function dispatchMetaCallbackEffects(
  ctx: Context,
  wiring: BotWiring,
  chatId: string,
  messageId: string,
  effects: readonly MetaCallbackEffect[],
): Promise<void> {
  for (const effect of effects) {
    if (effect.kind === "ack") {
      try {
        await ctx.answerCallbackQuery(effect.text ? { text: effect.text } : undefined);
      } catch (err) {
        // Same posture as ackCallback: an expired callback query must never crash the pipeline.
        process.stderr.write(`hostd: answerCallbackQuery (meta) gagal (kemungkinan kadaluwarsa): ${err}\n`);
      }
    } else if (effect.kind === "edit") {
      try {
        await editMetaMessage(wiring, chatId, messageId, effect.text, effect.buttons);
      } catch (err) {
        process.stderr.write(`hostd: gagal edit pesan meta utk ${wiring.config.id}/${chatId}: ${err}\n`);
      }
    } else {
      await dispatchMetaCommandResult(wiring, chatId, effect.result);
    }
  }
}

function botStateDir(bot: BotConfig): string {
  // Fase 1 default: hostd's own cwd, keyed by bot id — NOT the bot's
  // workspace dir (that belongs to the bot's own Claude Code session, not
  // hostd's channel-adapter state/inbox). Revisit if fase 2 wants this
  // configurable per bot.
  return join(process.cwd(), "state", bot.id);
}

/**
 * Task S1, Fase 2 — where THIS pilot bot watches for a bot-lama's legacy
 * `pending/*.json` mailbox (Task X2's `pending-consumer.ts`; recon-hooks.md
 * §D "hostd KONSUMSI selama fase 2"). No config field exists for "the old
 * wrapper's state dir" (that belongs to a DIFFERENT process/repo entirely),
 * so this reuses the same per-bot state area hostd already owns
 * (`botStateDir`) rather than inventing a new config knob for a mixed-fleet
 * window — documented assumption, revisit if a real migration needs the
 * dir to be independently configurable.
 */
function botPendingDir(bot: BotConfig): string {
  return join(botStateDir(bot), "pending");
}

export interface StartHostdOptions {
  /** Default: `loadConfig()` (reads MIRZA_HOSTD_CONFIG / ./hostd.config.json). Test-injectable to skip the filesystem entirely. */
  config?: HostdConfig;
  /** Default: `resolveDbPath()` (MIRZA_HOSTD_DB or `<cwd>/hostd.db`). Pass `:memory:` in tests. */
  dbPath?: string;
  /** Default: MIRZA_HOSTD_PIPE or PIPE_NAME_DEFAULT. Test-injectable so parallel test runs don't collide on one pipe name. */
  pipeName?: string;
  /**
   * Test-injectable poller factory (mock grammy — see telegram-adapter's
   * Task C3 `CreatePollerOptions.botFactory` pattern). MUST be supplied by
   * any test that calls `startHostd` — never let a test start a real
   * long-poll against Telegram.
   */
  createPoller?: TelegramAdapterDeps["createPoller"];
  /**
   * Task S1, Fase 2 — test-injectable holder factory (mock pty-holder — see
   * `supervisor.ts`'s own "test JANGAN spawn holder Node sungguhan"
   * constraint). Default: `spawnRealHolder` (spawns a real
   * `node --import tsx pty-holder/src/main.ts` child per bot).
   */
  spawnHolder?: SpawnHolderFn;
  /**
   * Task S1, Fase 2 — disable the X2 pending-consumer shim (default: on for
   * every configured bot). Tests that don't want real fs.watch/sweep timers
   * running against `state/<bot>/pending` can set this `false`.
   */
  enableLegacyPendingShim?: boolean;
  /**
   * Task E1' (Fase 2 assembly) — test-injectable grammy `Api` factory.
   * Default: `bot => new Api(bot.telegram_token)`. Every Telegram-facing send
   * in this module (pairing-reply, meta-command/meta-callback dispatch,
   * `/context`+`/version` via the bot's `OutboundSender`) ultimately goes
   * through the `Api` instance built here — overriding it lets a test capture
   * sent messages/edits with zero real network access, instead of a real
   * `new Api(...)` attempting an actual HTTPS call against a fake token.
   */
  createApi?: (bot: BotConfig) => Api;
  /**
   * Task S2/M1, Fase 2 assembly — test-injectable `SessionOps` instance
   * (session-ops.ts's `createSessionOps`). Default: a real one built from
   * `createSessionOps({db, supervisors: supervisors.supervisors})`. Session-
   * ops's `clearSession`/`rename` await a real injection ack (up to
   * `clearAckTimeoutMs`, ~135s by default) via `supervisor.queue` — a test
   * using `fakeSpawnHolder` (S1's own "JANGAN spawn holder Node sungguhan"
   * constraint) never actually acks an enqueued item, so exercising the meta-
   * command -> SessionOps wiring in a test needs a fake `SessionOps` here,
   * not the real ack-polling implementation.
   */
  sessionOps?: SessionOps;
}

export interface HostdHandle {
  db: Database;
  server: net.Server;
  pipe: string;
  config: HostdConfig;
  adapters: TelegramAdaptersHandle;
  delivery: DeliveryHandle;
  telegramSenders: ReadonlyMap<string, OutboundSender>;
  supervisors: SupervisorsHandle;
  /** Stop everything (adapters, delivery, supervisors, pending shims, unwire server delegates, close the pipe server + db). Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Assemble one running hostd instance. Extracted from `main()` (the
 * `if (import.meta.main)` entrypoint below just calls this with real deps)
 * so a smoke test can call it with an in-memory db, an inline config, and a
 * mock poller factory — exercising the FULL wiring (server, rpc-handlers,
 * delivery, inbound pipeline construction) without any real filesystem,
 * network, or Telegram polling.
 */
export async function startHostd(opts: StartHostdOptions = {}): Promise<HostdHandle> {
  const config = opts.config ?? loadConfig();
  const db = openDb(opts.dbPath ?? resolveDbPath());

  const pipe = opts.pipeName ?? process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;
  const server = await startServer(pipe);
  console.log(`[hostd] v${HOSTD_VERSION} siap — pipe: ${pipe} (pid ${process.pid})`);

  registerConfirmHandler((envelopeId, attemptToken) => confirmDelivery(db, envelopeId, attemptToken));

  const createApi = opts.createApi ?? ((bot: BotConfig) => new Api(bot.telegram_token));

  const wirings = new Map<string, BotWiring>();
  for (const bot of config.bots) {
    const api = createApi(bot);
    const messagesStore = createMessagesStore({ db, botId: bot.id, channel: "telegram" });
    const sender = createOutboundSender({
      botId: bot.id,
      api: toOutboundApi(api),
      store: messagesStore,
      access: () => getAccess(db, bot.id, "telegram"),
      stateDir: botStateDir(bot),
      token: bot.telegram_token,
    });
    wirings.set(bot.id, { config: bot, api, messagesStore, sender });
  }

  const telegramSenders = new Map<string, OutboundSender>([...wirings].map(([botId, w]) => [botId, w.sender]));

  const delivery = startDelivery(db, { isRegistered, push: pushEvent });

  // Task S1, Fase 2 — one BotSupervisor (holder spawn/restart/backoff +
  // injection queue) per configured bot. Built BEFORE the pipelines below:
  // session-ops (S2) needs `supervisors.supervisors` to enqueue /new /switch
  // /rename /delete /effort, and the inbound pipelines' `metaCommands.client`
  // needs session-ops.
  const supervisors = startSupervisors(config, db, { spawnHolder: opts.spawnHolder });

  // Task S2/M1, Fase 2 — session-ops (S2) wired to a SessionOpsClient (M1's
  // meta-commands.ts interface) via the thin same-process adaptor in
  // session-ops-client.ts. ONE instance for the whole process (matches
  // session-ops.ts's own shape — every method takes `bot` as a parameter
  // rather than session-ops being constructed per-bot).
  const sessionOps: SessionOps = opts.sessionOps ?? createSessionOps({ db, supervisors: supervisors.supervisors });
  const sessionOpsClient = createSessionOpsClient(sessionOps);

  // Task M2, Fase 2 — /context + /version deps: SessionQuery reads the exact
  // same `sessions` row `agent.status` does (INFRA-5); VersionQuery reads
  // hostd's + pty-holder's own package.json off disk (VER-1).
  const sessionQuery = createDbSessionQuery(db);
  const versionQuery = createPackageJsonVersionQuery({ hostdPkgJson: HOSTD_PKG_JSON, holderPkgJson: PTY_HOLDER_PKG_JSON });

  const pipelines = new Map(
    [...wirings].map(([botId, w]) => {
      const pipeline = createInboundPipeline({
        botId,
        access: () => getAccess(db, botId, "telegram"),
        store: w.messagesStore,
        enqueueEnv: env => enqueue(db, env),
        downloadFile: fileId => w.sender.handle({ op: "download_attachment", file_id: fileId }),
        onPending: (userId, code) => {
          const result = addPending(db, botId, userId, code, "telegram");
          if (!result.ok) {
            process.stderr.write(`hostd: addPending(${botId}, ${userId}) gagal: ${result.reason}\n`);
          }
        },
        onPairingReply: (chatId, result) => {
          void w.api.sendMessage(chatId, result.text).catch((err: unknown) => {
            process.stderr.write(`hostd: gagal mengirim pairing-reply ke ${botId}/${chatId}: ${err}\n`);
          });
        },
        // Task M1, Fase 2 — meta-commands (/new /switch /delete /rename
        // /effort) intercepted before AI delivery, routed to THIS bot's
        // session-ops (telegram-adapter and hostd's session-ops.ts are
        // IN-PROCESS here — no RPC hop, unlike cc-stub<->hostd).
        metaCommands: { bot: { id: botId, workspace: w.config.workspace }, client: sessionOpsClient },
      });
      return [botId, pipeline];
    }),
  );

  const adapters = startTelegramAdapters(config, {
    onInbound: async (botId, ctx) => {
      const msg = mapCtxToInboundMessage(ctx);
      if (!msg) return;
      const wiring = wirings.get(botId);
      if (!wiring) return; // Defensive — every configured bot has a wiring entry; unreachable in practice.

      // Task M2, Fase 2 — /context, /version: answered directly (never
      // forwarded to the AI), but ONLY after the SAME SEC-1 gate every other
      // command goes through — see tryAnswerInfoCommand's docstring.
      if (!msg.callback && (await tryAnswerInfoCommand(db, botId, msg, wiring, sessionQuery, versionQuery))) {
        return;
      }

      const pipeline = pipelines.get(botId);
      if (!pipeline) return; // Defensive — every configured bot has a pipeline; unreachable in practice.
      const outcome = await pipeline(msg);

      if (outcome.type === "meta-command") {
        // Task M1, Fase 2 — /new /switch /delete /rename /effort's result:
        // always a brand-new message (never forwarded to the AI).
        await dispatchMetaCommandResult(wiring, msg.chatId, outcome.result);
        return;
      }
      if (outcome.type === "meta-callback") {
        // Task M1, Fase 2 — a meta: button tap: ack (own text) + edit/reply,
        // per the ordered effect list. Replaces the generic ackCallback below
        // for this one outcome type — see dispatchMetaCallbackEffects's doc.
        await dispatchMetaCallbackEffects(ctx, wiring, msg.chatId, msg.messageId, outcome.effects);
        return;
      }
      // Fix E1-1: a button tap MUST be acked or the Telegram app's spinner on
      // that button never stops — see ackCallback's docstring above.
      if (msg.callback) await ackCallback(ctx, outcome);
    },
    ...(opts.createPoller ? { createPoller: opts.createPoller } : {}),
  });

  // X2 shim: watch each bot's legacy pending/*.json mailbox and forward
  // command/batch payloads into that bot's own injection queue
  // (recon-hooks.md §D — "hostd KONSUMSI selama fase 2").
  const pendingConsumers: PendingConsumerHandle[] = [];
  if (opts.enableLegacyPendingShim !== false) {
    for (const bot of config.bots) {
      const supervisor = supervisors.supervisors.get(bot.id);
      if (!supervisor) continue; // unreachable — startSupervisors mirrors config.bots 1:1
      pendingConsumers.push(
        startPendingConsumer({
          dir: botPendingDir(bot),
          botId: bot.id,
          enqueueEnv: env => enqueue(db, env),
          enqueueInject: req => supervisor.enqueueFromLegacy(req),
        }),
      );
    }
  }

  registerRpcHandlerDeps({
    db,
    config,
    telegramSenders,
    adapterStatuses: adapters.statuses,
    isRegistered,
    deliveryStats: () => delivery.stats(),
    supervisorStatuses: () => supervisors.statuses(),
    // H1: SessionStart hook -> session.started handler releases the /clear
    // barrier via supervisor.onSessionStarted(). Without this the handler
    // degrades to the 120s InjectionQueue barrier-timeout fallback.
    supervisors: supervisors.supervisors,
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const consumer of pendingConsumers) consumer.stop();
    await supervisors.stopAll();
    delivery.stop();
    await adapters.stopAll();
    registerConfirmHandler(null);
    registerRpcHandlerDeps(null);
    // Fix pass 1 (Bug 2): `server.close()` on its own waits for every open
    // connection to end BEFORE its callback fires. A still-connected
    // cc-stub client (which never calls `.end()` itself) hangs shutdown
    // forever, so `process.exit` in `main()`'s signal handlers is never
    // reached. Force-close first, then race the graceful close against a
    // fixed timeout as a last-resort fallback:
    //  1. `closeAllConnections` — Node's `net.Server` gained this in newer
    //     versions; guarded with optional chaining since the underlying
    //     transport (Bun's `net.Server`, at the time of writing) may not
    //     implement it.
    //  2. `destroyAllConnections` (server.ts) — force-destroys every
    //     registered cc-stub socket tracked in server.ts's `connections`
    //     map, covering the real-world case this bug is about even where
    //     (1) is unavailable.
    //  3. `SHUTDOWN_CLOSE_TIMEOUT_MS` race — resolves `shutdown()` even if
    //     some other, untracked socket unexpectedly stays open.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    destroyAllConnections();
    await Promise.race([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_CLOSE_TIMEOUT_MS)),
    ]);
    db.close();
  }

  return { db, server, pipe, config, adapters, delivery, telegramSenders, supervisors, shutdown };
}

async function main(): Promise<void> {
  const handle = await startHostd();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[hostd] ${sig} — shutdown rapi`);
      void handle.shutdown().then(() => process.exit(0));
    });
  }
}

if (import.meta.main) {
  await main();
}
