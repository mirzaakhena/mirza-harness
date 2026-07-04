import { randomUUID } from "node:crypto";

/**
 * Per-bot injection queue + clear-barrier gate — the "jantung" of Task S1.
 *
 * Kode acuan: `plugins/pty-controller/wrapper/src/wrapper.ts` (mirza-marketplace)
 * lines 209-253 (pacing constants) and 654-745 (`InjectionGate`/`injectionQueue`/
 * `drainInjectionQueue`), plus `wrapper/src/injection-gate.ts` (the pure gate
 * class this module's `InjectionGate` is a direct port of). See
 * `.superpowers/sdd/f2/recon-wrapper.md` §A/§E and `task-S1-brief.md`.
 *
 * Deliberate simplifications vs. kode acuan (this is a NEW system, not a
 * verbatim port):
 *  - No jsonl-polling. The clear barrier is released by an explicit
 *    `onSessionStarted()` call (S1 exposes it as an API + will be wired to
 *    the SessionStart hook in H1 — recon-hooks.md §B point 2) or by its own
 *    safety timeout.
 *  - No /rename or /resume chaining here — session naming flows through the
 *    hook-inversion data path (recon-hooks.md §B point 4), not PTY output
 *    sniffing.
 *  - `CLEAR_BARRIER_TIMEOUT_MS` is lowered from kode acuan's 10 minutes to
 *    2 minutes per the S1 brief ("turunkan jadi mis. 120000ms") — a timeout
 *    here now surfaces as a doctor ALARM (`barrierAlarm()`) rather than a
 *    silent log line, per "timeout → lepaskan + set ALARM doctor, BUKAN diam".
 *
 * Pure(-ish): all the state machine logic below is driven by an explicit
 * `now` (never reads `Date.now()` internally unless the caller didn't
 * supply a clock), and dispatch is a caller-supplied callback — this module
 * never touches a socket/child-process itself. `supervisor.ts` owns the
 * actual IPC to pty-holder and the `setInterval` that calls `tick()`.
 */

// ---------------------------------------------------------------------------
// Pacing constants (recon-wrapper.md §A line 11, wrapper.ts:209-253)
// ---------------------------------------------------------------------------

/** Minimum quiet time after every injection before the next one may start (SCAR-002). */
export const MIN_INJECTION_GAP_MS = 1_500;
/** Extra settle held after an injection's ack lands, so the next item doesn't crowd it (SCAR-003). */
export const POST_INJECTION_DELAY_MS = 1_000;
/** Safety valve: if a `/clear`'s fresh session never gets reported via `onSessionStarted`, force-release the barrier instead of deadlocking the queue forever. Lowered from kode acuan's 10min per the S1 brief. */
export const CLEAR_BARRIER_TIMEOUT_MS = 120_000;
/** Default poll interval `supervisor.ts` uses to call `tick()`. */
export const QUEUE_POLL_MS = 200;
/** Retries before an item is dead-lettered (IDEA-2 — visible, not silently dropped). */
export const MAX_INJECT_ATTEMPTS = 3;
/**
 * I1 fix: watchdog for a dispatched-but-never-acked step. Before this, only
 * `/clear` had any timeout (the barrier) — a holder that stayed alive but
 * simply stopped emitting `injected {id}` for a non-`/clear` step (no
 * `pty-error` either) left `pendingStep` populated forever: `tick()`
 * early-returns while a step is in flight, so the whole per-bot queue froze
 * permanently. Every non-`/clear` dispatch now arms this deadline; if
 * `onInjected` doesn't land before it elapses, `tick()` treats it exactly
 * like an `onError` (retry, then dead-letter after `MAX_INJECT_ATTEMPTS`).
 * `/clear` deliberately does NOT get this watchdog — it already has its own,
 * separate barrier timeout (`CLEAR_BARRIER_TIMEOUT_MS`) for the semantic
 * `onSessionStarted` ack; arming both would be redundant (and racy against
 * each other) for the same item.
 */
export const STEP_ACK_TIMEOUT_MS = 30_000;
/** Cap on `enqueueBatch` size — this queue's own limit (independent of the legacy mailbox's `MAX_BATCH_ITEMS` in `@mirza-harness/shared`'s `legacy-pending.ts`). */
export const MAX_BATCH_ITEMS = 8;

// ---------------------------------------------------------------------------
// Slash-guard (SEC-3 fix; recon-wrapper.md §C/§D, task brief "Slash-guard di
// titik enqueue")
// ---------------------------------------------------------------------------

/**
 * SEC-3 fix: kode acuan's MCP-layer regex (`^\/[a-z][a-z0-9_:-]{0,63}(\s[\s\S]{0,256})?$`)
 * used `[\s\S]` for the argument tail, which happily matches raw control
 * characters (NUL, ESC, CR/LF outside the intended split point, ...). Here
 * the argument tail is `[^\r\n\x00-\x1f]{0,256}` instead — printable text
 * only, no control characters — so a malformed/malicious argument can't
 * smuggle extra keystrokes into the PTY via the command string itself.
 */
export const SLASH_COMMAND_RE = /^\/[a-z][a-z0-9_:-]{0,63}([^\r\n\x00-\x1f]{0,256})?$/;

/**
 * Commands that exist only in the telegram/wrapper layer, not in Claude
 * Code itself — injecting them wedges the PTY on an unknown command.
 * Duplicated (not imported) from `plugins/pty-controller/slash-guards.ts`
 * (mirza-marketplace) — cross-repo import isn't available, same rationale
 * as `wrapper.ts`'s other intentional duplications (recon-wrapper.md §57 —
 * `writeTelegramRegistryName`'s docstring, "Option β").
 *
 * `/effort` is handled separately (see `guardSlashCommand`) — it pops a
 * confirm picker that only a trusted, supervisor-originated injection can
 * reasonably drive (`confirmAfterMs`), so it's blocked for AI/bus-originated
 * commands but allowed when `source: 'supervisor'`.
 */
const TELEGRAM_LAYER_COMMANDS: Record<string, string> = {
  "/new": "/new is a telegram-layer command, not a Claude Code command. Use a batch: [\"/clear\", \"/rename <name>\"].",
  "/switch": "/switch is a telegram-layer picker, not a Claude Code command. Inject \"/resume <sessionId>\" instead.",
  "/delete": "/delete is a telegram-layer picker that removes session files; Claude Code has no equivalent slash command.",
};

const EFFORT_COMMAND_WORD = "/effort";

export type InjectSource = "ai" | "supervisor";

export type SlashGuardResult = { ok: true } | { ok: false; error: string };

function commandWord(command: string): string {
  return (command.split(/\s/, 1)[0] ?? "").toLowerCase();
}

/**
 * Validate a slash command before it's ever allowed into the queue. Checked
 * at the ENQUEUE point (not just at dispatch) so a bad command surfaces
 * immediately to its caller rather than silently occupying a queue slot.
 */
export function guardSlashCommand(command: string, source: InjectSource = "ai"): SlashGuardResult {
  if (!SLASH_COMMAND_RE.test(command)) {
    return { ok: false, error: `invalid slash command syntax: ${JSON.stringify(command)}` };
  }
  const word = commandWord(command);
  if (word === EFFORT_COMMAND_WORD && source !== "supervisor") {
    return {
      ok: false,
      error: "/effort pops a confirm picker that only a supervisor-originated injection can drive — blocked from the AI/bus path.",
    };
  }
  const layerError = TELEGRAM_LAYER_COMMANDS[word];
  if (layerError) return { ok: false, error: layerError };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// InjectionGate — direct port of wrapper/src/injection-gate.ts
// ---------------------------------------------------------------------------

/**
 * Pure gate that serializes PTY injections (BUG #3, kode acuan 2026-06-07).
 * See the module docstring above and kode acuan's `injection-gate.ts` for
 * the full rationale — logic ported verbatim, only the default timeout
 * differs (S1 brief lowers it to `CLEAR_BARRIER_TIMEOUT_MS`).
 */
export class InjectionGate {
  private holdUntil = 0;
  private clearBarrierStartedAt: number | null = null;

  constructor(private readonly clearBarrierTimeoutMs: number = CLEAR_BARRIER_TIMEOUT_MS) {}

  /** Extend the do-not-inject window to at least `now + ms`. */
  holdFor(ms: number, now: number): void {
    this.holdUntil = Math.max(this.holdUntil, now + ms);
  }

  /** Arm the post-/clear barrier. */
  beginClearBarrier(now: number): void {
    this.clearBarrierStartedAt = now;
  }

  /** Release the barrier (session-started signal). `settleMs` holds the queue a little longer. */
  releaseClearBarrier(settleMs: number, now: number): void {
    this.clearBarrierStartedAt = null;
    this.holdFor(settleMs, now);
  }

  /**
   * True while the clear barrier is armed (and not timed out). Has the side
   * effect of clearing the barrier once the timeout is exceeded — callers
   * that need to distinguish "released by timeout" from "released by
   * `onSessionStarted`" MUST check this (and act on the transition) BEFORE
   * relying on `isBlocked`, exactly like kode acuan's `drainInjectionQueue`.
   */
  clearBarrierActive(now: number): boolean {
    if (this.clearBarrierStartedAt === null) return false;
    if (now - this.clearBarrierStartedAt > this.clearBarrierTimeoutMs) {
      this.clearBarrierStartedAt = null;
      return false;
    }
    return true;
  }

  /** True when the next injection must wait. */
  isBlocked(now: number): boolean {
    return this.clearBarrierActive(now) || now < this.holdUntil;
  }
}

// ---------------------------------------------------------------------------
// Queue item shapes
// ---------------------------------------------------------------------------

export type InjectItemKind = "slash" | "text" | "batch";
export type InjectItemState = "queued" | "sent" | "acked" | "failed" | "dead";

/** One command inside a `batch` item, or the shape a non-batch item's payload is normalized to for dispatch. */
export interface BatchSubItem {
  kind: "slash" | "text";
  payload: string;
}

export interface InjectItem {
  readonly id: string;
  readonly kind: InjectItemKind;
  readonly payload: string | readonly BatchSubItem[];
  state: InjectItemState;
  attempts: number;
  readonly createdAt: number;
}

export type EnqueueResult = { ok: true; id: string } | { ok: false; error: string };

interface PendingStep {
  itemId: string;
  /**
   * M1 fix: the correlation id actually sent to the holder for THIS attempt
   * — includes a monotonic per-attempt sequence suffix (`@N`) so a stale
   * `injected`/error echo from an earlier, already-failed attempt of the
   * SAME item can never match a later retry's `pendingStep` (the base id —
   * `item.id` or `item.id#idx` — used to be reused verbatim across retries,
   * which made that race possible).
   */
  stepId: string;
  unit: BatchSubItem;
  /**
   * I1 fix: deadline for this step's `injected` ack (`null` for `/clear`,
   * which relies on the separate clear-barrier timeout instead — see
   * `STEP_ACK_TIMEOUT_MS`'s docstring). Checked in `tick()`.
   */
  deadline: number | null;
}

export interface InjectionQueueOptions {
  /**
   * Send one command unit to the holder. `stepId` is the caller's own
   * correlation id (echoed back on `onInjected`) — for a plain item this is
   * the item's own `id`; for a batch sub-item it is `${itemId}#${index}`.
   * As of the M1 fix this base id ALSO carries a monotonic `@${attempt}`
   * suffix (unique per dispatch attempt, even retries of the same
   * item/sub-step) — see `PendingStep.stepId`'s docstring for why.
   */
  dispatch: (stepId: string, unit: BatchSubItem) => void;
  /** Fired when an item exhausts its retries and moves to `dead` (IDEA-2 — visible dead-letter). */
  onDead?: (item: InjectItem, reason: string) => void;
  /** Fired when the clear barrier force-releases via its safety timeout instead of `onSessionStarted` — the doctor ALARM signal. */
  onBarrierTimeout?: (item: InjectItem) => void;
  now?: () => number;
  minGapMs?: number;
  postInjectionDelayMs?: number;
  clearBarrierTimeoutMs?: number;
  maxAttempts?: number;
  /** I1 fix: per-dispatch ack watchdog for non-`/clear` steps (see `STEP_ACK_TIMEOUT_MS`). */
  stepAckTimeoutMs?: number;
}

/**
 * Per-bot FIFO injection queue with clear-barrier gating and dead-letter
 * visibility. One instance per bot (single-consumer — `supervisor.ts` is the
 * only thing that ever calls `tick()` for a given bot's queue).
 */
export class InjectionQueue {
  private readonly items: InjectItem[] = [];
  private readonly deadLetters: InjectItem[] = [];
  private readonly batchCursors = new Map<string, number>();
  private pendingStep: PendingStep | null = null;
  private awaitingBarrierItemId: string | null = null;
  private lastAckAt: number | null = null;
  private alarm = false;
  /** M1 fix: monotonic per-attempt sequence — see `PendingStep.stepId`'s docstring. */
  private attemptSeq = 0;

  private readonly gate: InjectionGate;
  private readonly dispatchFn: InjectionQueueOptions["dispatch"];
  private readonly onDead: NonNullable<InjectionQueueOptions["onDead"]>;
  private readonly onBarrierTimeout: NonNullable<InjectionQueueOptions["onBarrierTimeout"]>;
  private readonly nowFn: () => number;
  private readonly minGapMs: number;
  private readonly postInjectionDelayMs: number;
  private readonly maxAttempts: number;
  private readonly stepAckTimeoutMs: number;

  constructor(opts: InjectionQueueOptions) {
    this.dispatchFn = opts.dispatch;
    this.onDead = opts.onDead ?? (() => {});
    this.onBarrierTimeout = opts.onBarrierTimeout ?? (() => {});
    this.nowFn = opts.now ?? Date.now;
    this.minGapMs = opts.minGapMs ?? MIN_INJECTION_GAP_MS;
    this.postInjectionDelayMs = opts.postInjectionDelayMs ?? POST_INJECTION_DELAY_MS;
    this.maxAttempts = opts.maxAttempts ?? MAX_INJECT_ATTEMPTS;
    this.stepAckTimeoutMs = opts.stepAckTimeoutMs ?? STEP_ACK_TIMEOUT_MS;
    this.gate = new InjectionGate(opts.clearBarrierTimeoutMs ?? CLEAR_BARRIER_TIMEOUT_MS);
  }

  // -- enqueue -----------------------------------------------------------

  enqueueSlash(command: string, opts: { source?: InjectSource; id?: string } = {}): EnqueueResult {
    const guard = guardSlashCommand(command, opts.source ?? "ai");
    if (!guard.ok) return guard;
    const item = this.push("slash", command, opts.id);
    return { ok: true, id: item.id };
  }

  enqueueText(text: string, opts: { id?: string } = {}): EnqueueResult {
    if (text.length === 0) return { ok: false, error: "text payload must not be empty" };
    const item = this.push("text", text, opts.id);
    return { ok: true, id: item.id };
  }

  /**
   * `batch` = a unit kontigu atomik (ambiguitas #1 resolved): all sub-items
   * are stored as ONE queue slot, so nothing else can ever interleave
   * between them — there is no separate "merge N queue entries" step that
   * a concurrent enqueue could split. Single-consumer per bot + this
   * single-slot representation together make contiguity trivially true.
   */
  enqueueBatch(subItems: readonly BatchSubItem[], opts: { source?: InjectSource; id?: string } = {}): EnqueueResult {
    if (subItems.length === 0) return { ok: false, error: "batch must contain at least one item" };
    if (subItems.length > MAX_BATCH_ITEMS) return { ok: false, error: `batch too long (max ${MAX_BATCH_ITEMS})` };
    for (const sub of subItems) {
      if (sub.kind === "slash") {
        const guard = guardSlashCommand(sub.payload, opts.source ?? "ai");
        if (!guard.ok) return guard;
      } else if (sub.payload.length === 0) {
        return { ok: false, error: "batch text sub-item must not be empty" };
      }
    }
    const item = this.push("batch", subItems.slice(), opts.id);
    this.batchCursors.set(item.id, 0);
    return { ok: true, id: item.id };
  }

  private push(kind: InjectItemKind, payload: InjectItem["payload"], id?: string): InjectItem {
    const item: InjectItem = {
      id: id ?? randomUUID(),
      kind,
      payload,
      state: "queued",
      attempts: 0,
      createdAt: this.nowFn(),
    };
    this.items.push(item);
    return item;
  }

  // -- observability (doctor) ---------------------------------------------

  /** Active (not-yet-terminal) items, FIFO order — `doctor`'s `queue: N`. */
  list(): readonly InjectItem[] {
    return this.items;
  }

  /** Dead-lettered items (IDEA-2 — visible, never silently dropped). */
  deadLetterList(): readonly InjectItem[] {
    return this.deadLetters;
  }

  isAwaitingBarrier(): boolean {
    return this.awaitingBarrierItemId !== null;
  }

  /** Seconds since the last successful ack, or `null` if none yet — `doctor`'s `last_ack_s`. */
  lastAckAgeS(now: number = this.nowFn()): number | null {
    if (this.lastAckAt === null) return null;
    return Math.max(0, Math.floor((now - this.lastAckAt) / 1000));
  }

  /** Sticky ALARM: true once the clear barrier has force-released via timeout, until a fresh barrier is successfully armed. */
  barrierAlarm(): boolean {
    return this.alarm;
  }

  // -- driving the queue ---------------------------------------------------

  /** Called by `supervisor.ts`'s poll loop. No-op while a step is in flight or the gate is closed. */
  tick(now: number = this.nowFn()): void {
    // I1 fix: step-ack watchdog, checked BEFORE the `pendingStep` early
    // return below (mirrors the barrier-timeout ordering just below it) —
    // otherwise a step whose `injected` ack never arrives would wedge this
    // check out permanently along with the rest of `tick()`.
    if (this.pendingStep && this.pendingStep.deadline !== null && now >= this.pendingStep.deadline) {
      this.timeoutPendingStep(now);
    }

    if (this.pendingStep) return;

    // Barrier-timeout transition MUST be checked before `isBlocked` (which
    // would otherwise silently clear it as a side effect) — mirrors kode
    // acuan's `drainInjectionQueue` ordering exactly.
    if (this.awaitingBarrierItemId && !this.gate.clearBarrierActive(now)) {
      this.resolveAwaitingBarrierStep(now, { timedOut: true });
    }

    if (this.gate.isBlocked(now)) return;

    const front = this.frontUnit();
    if (!front) return;
    this.dispatchUnit(front, now);
  }

  private frontUnit(): { item: InjectItem; stepId: string; unit: BatchSubItem } | null {
    const item = this.items[0];
    if (!item) return null;
    if (item.kind === "batch") {
      const subs = item.payload as readonly BatchSubItem[];
      const idx = this.batchCursors.get(item.id) ?? 0;
      if (idx >= subs.length) return null; // shouldn't happen — finished batches are removed
      return { item, stepId: `${item.id}#${idx}`, unit: subs[idx]! };
    }
    return { item, stepId: item.id, unit: { kind: item.kind as "slash" | "text", payload: item.payload as string } };
  }

  private dispatchUnit(front: { item: InjectItem; stepId: string; unit: BatchSubItem }, now: number): void {
    // M1 fix: append a monotonic per-attempt sequence to the base id so this
    // attempt's correlation token is unique even on a retry of the exact
    // same item/sub-step — see `PendingStep.stepId`'s docstring.
    const token = `${front.stepId}@${this.attemptSeq++}`;
    // I1 fix: arm the step-ack watchdog for everything except `/clear`,
    // which has its own separate barrier timeout instead.
    const deadline = this.isClearCommand(front.unit) ? null : now + this.stepAckTimeoutMs;
    this.pendingStep = { itemId: front.item.id, stepId: token, unit: front.unit, deadline };
    front.item.state = "sent";
    this.gate.holdFor(this.minGapMs, now);
    this.dispatchFn(token, front.unit);
  }

  /** I1 fix: the in-flight step's `injected` ack never arrived before its deadline — treat it exactly like an `onError`. */
  private timeoutPendingStep(now: number): void {
    const step = this.pendingStep;
    if (!step) return;
    this.onError(step.stepId, `step-ack timeout after ${this.stepAckTimeoutMs}ms (no injected/pty-error from holder)`, now);
  }

  private isClearCommand(unit: BatchSubItem): boolean {
    return unit.kind === "slash" && commandWord(unit.payload) === "/clear";
  }

  /**
   * Ack level = keystroke typed (pty-holder's `injected {id}` event — see
   * `pty-holder/src/ipc.ts`'s docstring: "typed, not semantically
   * processed"). For everything except `/clear`, that IS the item's
   * success signal. For `/clear`, the contract requires the FURTHER
   * semantic signal `onSessionStarted()` before the item is truly acked —
   * see recon-hooks.md §B point 3.
   */
  onInjected(stepId: string, now: number = this.nowFn()): void {
    if (!this.pendingStep || this.pendingStep.stepId !== stepId) return; // stale/unknown — ignore
    const { itemId, unit } = this.pendingStep;
    const item = this.items.find(i => i.id === itemId);
    this.pendingStep = null;
    if (!item) return; // defensive — shouldn't happen, item only leaves `items` once fully acked/dead

    this.gate.holdFor(this.postInjectionDelayMs, now);

    if (this.isClearCommand(unit)) {
      this.gate.beginClearBarrier(now);
      this.awaitingBarrierItemId = item.id;
      this.alarm = false; // fresh barrier armed — clear any stale alarm from a previous cycle
      // item stays 'sent': the semantic ack (onSessionStarted) or the
      // safety timeout is what completes it.
      return;
    }

    this.advanceOrComplete(item, now);
  }

  /** Advance a batch's cursor past its current step, or complete a non-batch item. */
  private advanceOrComplete(item: InjectItem, now: number): void {
    if (item.kind === "batch") {
      const idx = (this.batchCursors.get(item.id) ?? 0) + 1;
      const subs = item.payload as readonly BatchSubItem[];
      if (idx >= subs.length) {
        this.completeItem(item, "acked", now);
      } else {
        this.batchCursors.set(item.id, idx);
        // stays 'sent' — next tick dispatches the next sub-item once the gate opens
      }
      return;
    }
    this.completeItem(item, "acked", now);
  }

  private resolveAwaitingBarrierStep(now: number, opts: { timedOut: boolean }): void {
    const itemId = this.awaitingBarrierItemId;
    this.awaitingBarrierItemId = null;
    if (!itemId) return;
    const item = this.items.find(i => i.id === itemId);
    if (opts.timedOut) {
      this.alarm = true;
      if (item) this.onBarrierTimeout(item);
    } else {
      this.gate.releaseClearBarrier(this.postInjectionDelayMs, now);
    }
    if (!item) return;
    this.advanceOrComplete(item, now);
  }

  /**
   * The semantic ack for a `/clear` in flight — called from `supervisor.ts`
   * on every `SessionStart` (H1's hook wiring), not just after a `/clear`:
   * safe/no-op when nothing is awaiting the barrier.
   */
  onSessionStarted(now: number = this.nowFn()): void {
    if (!this.awaitingBarrierItemId) return;
    this.resolveAwaitingBarrierStep(now, { timedOut: false });
  }

  /**
   * A step failed (`pty-error` from the holder, or the holder died mid-flight
   * — see `resetInFlight`). Retries up to `maxAttempts`; beyond that the
   * WHOLE item (batches can't skip a broken sub-step and stay atomic) is
   * dead-lettered (IDEA-2 — visible via `deadLetterList()`, not silently
   * dropped).
   */
  onError(stepId: string, reason: string, now: number = this.nowFn()): void {
    if (!this.pendingStep || this.pendingStep.stepId !== stepId) return;
    const { itemId } = this.pendingStep;
    this.pendingStep = null;
    const item = this.items.find(i => i.id === itemId);
    if (!item) return;

    item.attempts += 1;
    if (item.attempts >= this.maxAttempts) {
      this.completeItem(item, "dead", now);
      this.onDead(item, reason);
      return;
    }
    // Stays 'sent' at its current (item/batch-cursor) position — the next
    // tick redispatches the SAME step. Brief backoff so failures don't
    // hot-loop the poller.
    this.gate.holdFor(this.minGapMs, now);
  }

  /**
   * Called by `supervisor.ts` when the holder process dies (or is force-
   * killed) while a step was in flight and no `injected`/`pty-error` ever
   * arrived for it — treated the same as an explicit `pty-error`.
   */
  resetInFlight(reason: string, now: number = this.nowFn()): void {
    if (!this.pendingStep) return;
    this.onError(this.pendingStep.stepId, reason, now);
  }

  private completeItem(item: InjectItem, state: "acked" | "dead", now: number): void {
    item.state = state;
    const idx = this.items.findIndex(i => i.id === item.id);
    if (idx >= 0) this.items.splice(idx, 1);
    this.batchCursors.delete(item.id);
    if (state === "acked") this.lastAckAt = now;
    else this.deadLetters.push(item);
  }
}
