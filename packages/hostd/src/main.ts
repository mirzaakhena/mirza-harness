import { join } from "node:path";
import type net from "node:net";
import type { Database } from "bun:sqlite";
import { Api } from "grammy";
import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";
import { createInboundPipeline, createOutboundSender, type OutboundApi, type OutboundSender } from "@mirza-harness/telegram-adapter";
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

function botStateDir(bot: BotConfig): string {
  // Fase 1 default: hostd's own cwd, keyed by bot id — NOT the bot's
  // workspace dir (that belongs to the bot's own Claude Code session, not
  // hostd's channel-adapter state/inbox). Revisit if fase 2 wants this
  // configurable per bot.
  return join(process.cwd(), "state", bot.id);
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
}

export interface HostdHandle {
  db: Database;
  server: net.Server;
  pipe: string;
  config: HostdConfig;
  adapters: TelegramAdaptersHandle;
  delivery: DeliveryHandle;
  telegramSenders: ReadonlyMap<string, OutboundSender>;
  /** Stop everything (adapters, delivery, unwire server delegates, close the pipe server + db). Idempotent. */
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

  const wirings = new Map<string, BotWiring>();
  for (const bot of config.bots) {
    const api = new Api(bot.telegram_token);
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
      });
      return [botId, pipeline];
    }),
  );

  const adapters = startTelegramAdapters(config, {
    onInbound: async (botId, ctx) => {
      const msg = mapCtxToInboundMessage(ctx);
      if (!msg) return;
      const pipeline = pipelines.get(botId);
      if (!pipeline) return; // Defensive — every configured bot has a pipeline; unreachable in practice.
      await pipeline(msg);
    },
    ...(opts.createPoller ? { createPoller: opts.createPoller } : {}),
  });

  registerRpcHandlerDeps({
    db,
    config,
    telegramSenders,
    adapterStatuses: adapters.statuses,
    isRegistered,
    deliveryStats: () => delivery.stats(),
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
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

  return { db, server, pipe, config, adapters, delivery, telegramSenders, shutdown };
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
