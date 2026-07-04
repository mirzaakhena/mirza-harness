import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { OutboundSender } from "@mirza-harness/telegram-adapter";
import type { PollerStatus } from "@mirza-harness/telegram-adapter";
import { Envelope, TelegramOutboundParams, AgentStatusParams, AgentSendParams, type EnvelopeT } from "@mirza-harness/shared";
import type { HostdConfig } from "./config";
import { enqueue } from "./bus/bus";
import { composeAgentPrompt } from "./bus/marker";
import type { DeliveryStats } from "./bus/delivery";
import type { DoctorSupervisorStatusLike } from "./doctor";

/**
 * Task D2, Fase 1 — hostd's side of the cc-stub tools proxy: `server.ts`
 * only wires these functions into its RPC method table (see
 * `registerRpcHandlerDeps`); ALL validation (zod, from `@mirza-harness/shared`'s
 * rpc.ts) and side effects (Telegram send, bus enqueue, config lookups)
 * live here, per the brief's "hostd yang memvalidasi + eksekusi".
 *
 * LIMITATIONS (documented, not fixed here — see delivery.ts's own docstring
 * point (b)): the bus's `channel.deliver` is at-least-once, not
 * exactly-once. `telegram.outbound` itself is a direct RPC call (request/
 * response over the pipe), not something replayed by the bus — but an
 * inbound `agent.send` prompt CAN be delivered to a bot's cc-stub twice
 * (confirm race/timeout), which can make that bot's AI process the same
 * instruction twice and call `reply` twice as a result, sending the
 * Telegram message twice. There is no functional dedup here (would need an
 * idempotency key threaded from the originating envelope through the tool
 * call, out of scope for D2); cc-stub's `channel.deliver` handler logs the
 * envelope_id at delivery time (see server.ts's `onInfo`) so a double-send
 * incident can at least be correlated back to the retried envelope.
 */

export interface RpcHandlerDeps {
  db: Database;
  config: HostdConfig;
  /** bot_id -> outbound sender (telegram-adapter's `createOutboundSender`, one per configured bot). */
  telegramSenders: ReadonlyMap<string, OutboundSender>;
  /** bot_id -> latest poller status (from `startTelegramAdapters`'s `.statuses`). */
  adapterStatuses: ReadonlyMap<string, PollerStatus>;
  /** Whether bot_id's cc-stub currently has a registered IPC connection (server.ts's `isRegistered`). */
  isRegistered: (botId: string) => boolean;
  /** Injectable clock (ms) — default `Date.now`. */
  now?: () => number;
  /**
   * Not used by any of the 4 RPC handlers below — carried here purely so
   * `main.ts` can register ONE deps object (`registerRpcHandlerDeps`) that
   * also feeds `server.ts`'s `doctor` handler (`startDelivery(...).stats`).
   * Optional so tests exercising the 4 handlers above don't need to supply it.
   */
  deliveryStats?: () => DeliveryStats;
  /**
   * Task S1, Fase 2 — same carry-through pattern as `deliveryStats`: not
   * used by the 4 RPC handlers below, exists so `main.ts` can register one
   * deps object that ALSO feeds `server.ts`'s `doctor` handler with real
   * per-bot supervisor status (`startSupervisors(...).statuses()`).
   */
  supervisorStatuses?: () => Readonly<Record<string, DoctorSupervisorStatusLike>>;
}

function nowMs(deps: RpcHandlerDeps): number {
  return (deps.now ?? Date.now)();
}

// ---------------------------------------------------------------------------
// telegram.outbound {bot_id, cmd} -> the bot's OutboundSender.
// ---------------------------------------------------------------------------

export async function handleTelegramOutbound(params: unknown, deps: RpcHandlerDeps): Promise<string> {
  const { bot_id, cmd } = TelegramOutboundParams.parse(params);
  const sender = deps.telegramSenders.get(bot_id);
  if (!sender) {
    throw new Error(`telegram.outbound: tidak ada sender terdaftar utk bot_id "${bot_id}" (bot tak dikenal di config, atau adapter belum start)`);
  }
  return sender.handle(cmd);
}

// ---------------------------------------------------------------------------
// agent.list -> bots dari config + status poller/stub-connection.
// ---------------------------------------------------------------------------

export interface AgentListEntry {
  name: string;
  workspace: string;
  poller_status: string;
  stub_connected: boolean;
}

export function handleAgentList(_params: unknown, deps: RpcHandlerDeps): AgentListEntry[] {
  return deps.config.bots.map(bot => ({
    name: bot.id,
    workspace: bot.workspace,
    poller_status: deps.adapterStatuses.get(bot.id)?.state ?? "unknown",
    stub_connected: deps.isRegistered(bot.id),
  }));
}

// ---------------------------------------------------------------------------
// agent.status {name} -> bot info + baris sessions terbaru (fase 1: selalu
// null — tabel sessions belum ada penulis; hook SessionStart fase 2 mengisi).
// ---------------------------------------------------------------------------

export interface AgentStatusSessionRow {
  id: string;
  name: string;
  lifecycle: string;
  started_at: number;
  ended_at: number | null;
}

export interface AgentStatusResult {
  name: string;
  workspace: string;
  poller_status: string;
  stub_connected: boolean;
  /**
   * Fase 1: SELALU null — `sessions` (schema.ts) tidak punya penulis sampai
   * hook SessionStart (fase 2) menulis baris begitu sebuah sesi Claude Code
   * mulai. Ini query nyata (bukan hardcode), jadi begitu fase 2 menulis
   * baris, field ini otomatis terisi tanpa ubahan kode di sini — kembalikan
   * apa adanya, JANGAN fake data.
   */
  session: AgentStatusSessionRow | null;
}

export function handleAgentStatus(params: unknown, deps: RpcHandlerDeps): AgentStatusResult {
  const { name } = AgentStatusParams.parse(params);
  const bot = deps.config.bots.find(b => b.id === name);
  if (!bot) {
    const known = deps.config.bots.map(b => b.id).join(", ") || "(none)";
    throw new Error(`agent.status: bot "${name}" tak dikenal di hostd config. Known: ${known}`);
  }

  const session = deps.db
    .query(
      `SELECT id, name, lifecycle, started_at, ended_at
         FROM sessions
        WHERE bot_id = ?
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get(name) as AgentStatusSessionRow | null;

  return {
    name,
    workspace: bot.workspace,
    poller_status: deps.adapterStatuses.get(name)?.state ?? "unknown",
    stub_connected: deps.isRegistered(name),
    session,
  };
}

// ---------------------------------------------------------------------------
// agent.send {from?, target, payload} -> composeAgentPrompt -> enqueue bus
// kind 'prompt' per target -> delivery existing mengantar sbg channel
// notification. Balikan JUJUR per target (SCAR-071): {target, queued, reason?}.
// ---------------------------------------------------------------------------

export interface AgentSendResult {
  target: string;
  queued: boolean;
  reason?: string;
}

export function handleAgentSend(params: unknown, deps: RpcHandlerDeps): AgentSendResult[] {
  const parsed = AgentSendParams.parse(params);
  const from = parsed.from ?? "unknown";
  const targets = Array.isArray(parsed.target) ? parsed.target : [parsed.target];
  const hop = parsed.payload.hop_count ?? 0;
  const composed = composeAgentPrompt(from, hop, parsed.payload.body);
  const knownBotIds = new Set(deps.config.bots.map(b => b.id));
  const ts = Math.floor(nowMs(deps) / 1000);

  return targets.map((target): AgentSendResult => {
    if (!knownBotIds.has(target)) {
      return { target, queued: false, reason: `bot "${target}" tak terdaftar di hostd config — tidak di-enqueue` };
    }
    const env: EnvelopeT = Envelope.parse({
      id: randomUUID(),
      ts,
      from,
      to: target,
      kind: "prompt",
      payload: { content: composed, meta: { from, hop: String(hop), kind: "agent-prompt" } },
      hop,
    });
    const queued = enqueue(deps.db, env);
    return queued ? { target, queued: true } : { target, queued: false, reason: "enqueue no-op (id sudah ada di bus_queue)" };
  });
}
