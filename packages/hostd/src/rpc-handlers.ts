import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { OutboundSender } from "@mirza-harness/telegram-adapter";
import type { PollerStatus } from "@mirza-harness/telegram-adapter";
import { Envelope, TelegramOutboundParams, AgentStatusParams, AgentSendParams, type EnvelopeT } from "@mirza-harness/shared";
import type { HostdConfig, BotConfig } from "./config";
import { enqueue } from "./bus/bus";
import { composeAgentPrompt } from "./bus/marker";
import type { DeliveryStats } from "./bus/delivery";
import type { DoctorSupervisorStatusLike } from "./doctor";
import type { BotSupervisor } from "./supervisor/supervisor";

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
  /**
   * Task H1, Fase 2 — bot_id -> BotSupervisor, needed so `session.started`
   * (below) can release that bot's `/clear` barrier
   * (`BotSupervisor.onSessionStarted()`, hook-inversion §5 step 2 —
   * recon-hooks.md §B). `Pick<...>` rather than the full class: this is the
   * only method `handleSessionStarted` needs, which keeps a test's fake
   * supervisor to `{ onSessionStarted: () => ... }` — no need to construct a
   * real `BotSupervisor` (which spawns a pty-holder child) just to verify the
   * barrier-release call happened.
   *
   * Optional carry-through, same pattern as `deliveryStats`/`supervisorStatuses`
   * above: tests exercising `handleSessionStarted` may omit it (barrier
   * release then silently no-ops — the sessions upsert + reply still work).
   *
   * PRODUCTION WIRING NOTE: `main.ts` is outside this task's allowed file
   * scope (see task brief), so its `registerRpcHandlerDeps({...})` call has
   * NOT been updated to actually pass this field — needs
   * `supervisors: supervisors.supervisors` added there (the `SupervisorsHandle`
   * `startSupervisors(...)` already returns in main.ts has exactly this map)
   * as a follow-up integration step, or `onSessionStarted()` never fires in
   * the real running process and the queue barrier this method exists to
   * release stays stuck until its own safety-timeout/alarm.
   */
  supervisors?: ReadonlyMap<string, Pick<BotSupervisor, "onSessionStarted">>;
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
  /**
   * Task M2, Fase 2 — telemetry columns (schema.ts), written by cc-stub's
   * `scripts/context-bridge.ts` via the `telemetry.report` RPC below. NULL
   * until the first CC statusLine snapshot fires for this session (FUNC-1:
   * "no data yet" is a real, distinguishable state — never faked as 0/"").
   * `context-command.ts` (telegram-adapter) reads this SAME query result
   * (via `agent.status`) to render `/context` — INFRA-5: one row, one
   * writer, both readers agree by construction.
   */
  used_percentage: number | null;
  context_window_size: number | null;
  model: string | null;
  effort: string | null;
  cost: number | null;
  captured_at_ms: number | null;
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
      `SELECT id, name, lifecycle, started_at, ended_at,
              used_percentage, context_window_size, model, effort, cost, captured_at_ms
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

// ---------------------------------------------------------------------------
// session.started {bot_id, session_id, source, cwd} — Task H1, Fase 2.
//
// Called by cc-stub's SessionStart hook (`packages/cc-stub/hooks/session-start.ts`)
// on every fresh Claude Code session. Three things happen, in order:
//   1. Resolve WHICH configured bot this is — by `cwd` matching a
//      `config.bots[].workspace` entry (recon-hooks.md §B: "bot dari mapping
//      config workspace->bot"), falling back to the hook's self-reported
//      `bot_id` only if no workspace matches. hostd is the single writer of
//      state (§B's "peran" line) and shouldn't blindly trust an arbitrary
//      `bot_id` string from a short-lived, unauthenticated hook process when
//      the more reliable signal (which workspace it's actually running in)
//      is available in the same payload.
//   2. Upsert the `sessions` row (schema.ts) for this `session_id`: a brand
//      new id gets a fresh row (name/lifecycle default 'idle'); an id that
//      already exists (the SAME session firing SessionStart again — e.g.
//      `source: "clear"` or "resume" for a session `BotSupervisor.clearSession()`
//      had just marked `lifecycle='resetting'` via `setLatestSessionLifecycle`)
//      only has its `lifecycle` flipped back to 'idle' (fix M4 from the S1
//      review — a resetting session must not stay stuck once SessionStart
//      actually fires) — `name`/`started_at` are left untouched on conflict so
//      a session's name (S2's rename path) or its true original start time
//      survive a clear/resume cycle. LOSS-1: no jsonl/encoding guessing
//      anywhere in this path — the row is written from validated RPC params
//      only.
//   3. Release that bot's `/clear` barrier (`BotSupervisor.onSessionStarted()`
//      -> `InjectionQueue.onSessionStarted()`) — hook-inversion §5 step 2,
//      the whole point of this handler existing: a fresh SessionStart is the
//      real, verifiable "the session actually cleared" signal that replaces
//      the retired 10-minute jsonl-polling clear-barrier.
//
// Reply carries `additionalContext` built from `sessions.name` — INFRA-5:
// the exact same source `handleAgentStatus` above reads, so the hook's
// injected context and `agent_status`/`agent.status` can never disagree.
// ---------------------------------------------------------------------------

const SessionStartedParams = z
  .object({
    bot_id: z.string().min(1),
    session_id: z.string().min(1),
    source: z.string().min(1),
    cwd: z.string().min(1),
  })
  .strict();

export type SessionStartedParamsT = z.infer<typeof SessionStartedParams>;

export interface SessionStartedResult {
  additionalContext: string;
}

/** `C:\foo\bar\` and `C:/foo/bar` (and case) should compare equal cross-platform. */
function normalizeWorkspacePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Resolve the config bot for a `session.started` call — workspace match first, `bot_id` as fallback. Throws (visible failure, §2.5) if neither resolves. */
function resolveBotForSessionStarted(params: SessionStartedParamsT, config: HostdConfig): BotConfig {
  const normalizedCwd = normalizeWorkspacePath(params.cwd);
  const byWorkspace = config.bots.find(b => normalizeWorkspacePath(b.workspace) === normalizedCwd);
  if (byWorkspace) return byWorkspace;

  const byId = config.bots.find(b => b.id === params.bot_id);
  if (byId) return byId;

  const known = config.bots.map(b => `${b.id} (${b.workspace})`).join(", ") || "(none)";
  throw new Error(
    `session.started: cwd "${params.cwd}" (bot_id klaim "${params.bot_id}") tidak cocok workspace bot manapun di hostd config. Known: ${known}`,
  );
}

export function handleSessionStarted(params: unknown, deps: RpcHandlerDeps): SessionStartedResult {
  const parsed = SessionStartedParams.parse(params);
  const bot = resolveBotForSessionStarted(parsed, deps.config);
  const startedAt = Math.floor(nowMs(deps) / 1000);

  // `sessions.bot_id` has a `REFERENCES bots(id)` foreign key (schema.ts) but
  // nothing in the current production wiring (main.ts) ever populates the
  // `bots` table — ensure the row exists here so the INSERT below can't fail
  // an FK check on a bot's very first session. Idempotent no-op once present.
  deps.db.run(
    `INSERT INTO bots (id, workspace) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET workspace = excluded.workspace`,
    [bot.id, bot.workspace],
  );

  deps.db.run(
    `INSERT INTO sessions (id, bot_id, name, lifecycle, started_at)
     VALUES (?, ?, 'idle', 'idle', ?)
     ON CONFLICT(id) DO UPDATE SET bot_id = excluded.bot_id, lifecycle = 'idle'`,
    [parsed.session_id, bot.id, startedAt],
  );

  // Hook-inversion §5 step 2 — see module-level comment above.
  deps.supervisors?.get(bot.id)?.onSessionStarted();

  const row = deps.db.query(`SELECT name FROM sessions WHERE id = ?`).get(parsed.session_id) as { name: string } | null;
  const name = row?.name ?? "idle";

  return { additionalContext: `Current session name: "${name}"` };
}

// ---------------------------------------------------------------------------
// telemetry.report {bot_id, session_id, used_percentage, context_window_size,
// model, effort, cost, captured_at_ms} — Task M2, Fase 2.
//
// Called (best-effort) by cc-stub's `scripts/context-bridge.ts` on every CC
// statusLine invocation. Updates the telemetry columns (schema.ts's Task M2
// additions) of the ALREADY-EXISTING `sessions` row for (bot_id, session_id)
// — that row is written by `handleSessionStarted` above when the session's
// SessionStart hook fires, which always happens before its first statusLine
// snapshot, so in the normal case the row is already there.
//
// Every field besides bot_id/session_id is nullable (accepts `null` or
// omission) — cc-stub's `parseStatusLineInput` (context-bridge.ts) may not
// find every field in a given CC snapshot; whatever it DID find still gets
// written, whatever it didn't stays/becomes NULL (matches the columns'
// nullable contract, FUNC-1).
//
// Does NOT throw when no matching row exists yet (race: statusLine fires
// before SessionStart's RPC lands, or the session already ended) — this is
// a best-effort telemetry write, not a business-rule validation; the honest
// `{updated: false}` return lets a caller notice without treating it as a
// wire-level error. `bot_id` is validated but NOT cross-checked against
// hostd config (unlike `agent.status`'s `name`) — a stale/renamed bot_id
// here simply fails to match any row (`updated: false`), which is the
// correct "nothing to update" outcome, not a config lookup failure.
// ---------------------------------------------------------------------------

const TelemetryReportParams = z
  .object({
    bot_id: z.string().min(1),
    session_id: z.string().min(1),
    used_percentage: z.number().nullable().optional(),
    context_window_size: z.number().nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    cost: z.number().nullable().optional(),
    captured_at_ms: z.number().nullable().optional(),
  })
  .strict();

export type TelemetryReportParamsT = z.infer<typeof TelemetryReportParams>;

export interface TelemetryReportResult {
  /** `true` iff a `sessions` row for (bot_id, session_id) existed and was updated. */
  updated: boolean;
}

export function handleTelemetryReport(params: unknown, deps: RpcHandlerDeps): TelemetryReportResult {
  const parsed = TelemetryReportParams.parse(params);

  const result = deps.db.run(
    `UPDATE sessions
        SET used_percentage = ?, context_window_size = ?, model = ?, effort = ?, cost = ?, captured_at_ms = ?
      WHERE id = ? AND bot_id = ?`,
    [
      parsed.used_percentage ?? null,
      parsed.context_window_size ?? null,
      parsed.model ?? null,
      parsed.effort ?? null,
      parsed.cost ?? null,
      parsed.captured_at_ms ?? null,
      parsed.session_id,
      parsed.bot_id,
    ],
  );

  return { updated: result.changes > 0 };
}
