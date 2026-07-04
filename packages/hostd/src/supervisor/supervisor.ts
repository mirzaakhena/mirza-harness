import { randomUUID } from "node:crypto";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Database } from "bun:sqlite";
import type { BotConfig } from "../config";
import { setLatestSessionLifecycle } from "../state/sessions-store";
import {
  InjectionQueue,
  type BatchSubItem,
  type EnqueueResult,
  type InjectSource,
} from "./injection";

/**
 * bot-supervisor core — Task S1, Fase 2 ("jantung fase 2"). Spawns/restarts
 * one pty-holder child process per bot, wires its IPC events into that
 * bot's `InjectionQueue`, and reports status for `doctor`.
 *
 * Kode acuan: `plugins/pty-controller/wrapper/src/wrapper.ts` (mirza-marketplace)
 * — spawn chain (553-587), `pending-consumer`'s `enqueueInject` contract
 * (Task X2). pty-holder's own IPC contract: `packages/pty-holder/src/ipc.ts` +
 * README ("Exit-time contract (S1)" — the 5s OS force-kill fallback this
 * module implements is exactly the safety net that README's docstring
 * requires of a caller).
 *
 * pty-holder runs under **Node**, never Bun (native `node-pty` — see its
 * README), so it is always spawned as `node --import tsx <path-to-main.ts>`,
 * regardless of what runtime hostd itself is running under.
 */

// ---------------------------------------------------------------------------
// HolderHandle — the thing supervisor.ts drives. Real impl below; tests
// supply a fake (`spawnHolder` factory override) so `bun test` never spawns
// a real Node child / node-pty.
// ---------------------------------------------------------------------------

export type HolderEvent = "injected" | "pty-error" | "pty-exit" | "exit";

export interface HolderHandle {
  /** Send an `inject` request; `stepId` is the correlation id echoed back on the later `injected` event. */
  inject(stepId: string, text: string, submit: boolean): void;
  /** Send an `inject-slash` request. */
  injectSlash(stepId: string, command: string, confirmAfterMs?: number): void;
  /** Request graceful shutdown over IPC. Resolves once the holder's `{ok:true}` response arrives — does NOT itself enforce a timeout; the caller (`BotSupervisor.stop`) owns the OS force-kill fallback. */
  shutdown(): Promise<void>;
  /**
   * Last-resort OS-level kill — used when `shutdown()` doesn't settle within
   * the supervisor's own grace window. `signal` defaults to `SIGTERM`; I2
   * fix: `BotSupervisor.stop()` now escalates explicitly to `SIGKILL` for a
   * holder that ignored the graceful shutdown RPC entirely (a wedged holder
   * can trap/ignore SIGTERM, but not SIGKILL).
   */
  forceKill(signal?: NodeJS.Signals): void;
  on(event: "injected", cb: (id: string) => void): void;
  on(event: "pty-error", cb: (message: string) => void): void;
  on(event: "pty-exit", cb: (info: { code: number; signal: number | null }) => void): void;
  /** Native child-process exit (fires even if the holder crashed before emitting `pty-exit` itself). */
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SpawnHolderOptions {
  /** Absolute path to pty-holder's `main.ts` — overridable for tests that DO want to exercise a real child (see the package's own `test-integration.mjs` pattern); defaults to the real on-disk sibling package. */
  ptyHolderMainPath?: string;
  /** Override the `node` executable — default `"node"` (must resolve on PATH). */
  nodeBin?: string;
  /** Absolute path to tsx's ESM loader — see `DEFAULT_TSX_LOADER`'s docstring for why this is resolved by absolute path rather than the bare `"tsx"` specifier. */
  tsxLoaderPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/hostd/src/supervisor -> packages/pty-holder/src/main.ts */
const DEFAULT_PTY_HOLDER_MAIN = join(__dirname, "..", "..", "..", "pty-holder", "src", "main.ts");
/**
 * packages/hostd/src/supervisor -> packages/pty-holder/node_modules/tsx/dist/loader.mjs.
 *
 * Resolved as an ABSOLUTE path, not the bare `"tsx"` specifier the package
 * README's `node --import tsx src/main.ts` example shows. That example
 * assumes the process's cwd IS the pty-holder package directory (so Node's
 * bare-specifier resolution finds `tsx` in its own `node_modules`) — true
 * when a human runs the README's command by hand, but NOT true here: this
 * holder's inner `claude`/shell process inherits the pty-holder Node
 * process's own cwd 1:1 (`pty.ts`'s `spawnClaudePty` has no separate cwd
 * parameter of its own), so `spawnRealHolder` MUST set `cwd: bot.workspace`
 * for the bot's session to run in the right directory. That breaks bare
 * `--import tsx` resolution (tsx lives only in pty-holder's own
 * `node_modules`, never hoisted into an arbitrary bot workspace — confirmed
 * by direct repro: `ERR_MODULE_NOT_FOUND` for `tsx` when cwd is anywhere
 * else). Passing tsx's loader by absolute file path sidesteps Node's
 * cwd-relative package resolution entirely.
 */
const DEFAULT_TSX_LOADER = join(__dirname, "..", "..", "..", "pty-holder", "node_modules", "tsx", "dist", "loader.mjs");

/**
 * Real implementation: spawns `node --import <tsx loader> <pty-holder main.ts>`,
 * speaks the NDJSON JSON-RPC protocol over stdio (ipc.ts's contract),
 * cwd = bot's workspace (so the held `claude`/shell session runs there —
 * see `DEFAULT_TSX_LOADER`'s docstring for why tsx itself is NOT resolved
 * relative to that cwd), env carries CLAUDE_BIN/CLAUDE_ARGS per bot.
 */
export function spawnRealHolder(bot: BotConfig, opts: SpawnHolderOptions = {}): HolderHandle {
  const nodeBin = opts.nodeBin ?? "node";
  const mainPath = opts.ptyHolderMainPath ?? DEFAULT_PTY_HOLDER_MAIN;
  // `--import` resolves its specifier as an ESM import, not a plain CLI path
  // — on Windows, a raw `C:\...` path there is parsed as if `C:` were a URL
  // scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`; confirmed via direct repro).
  // `pathToFileURL(...).href` produces the `file:///C:/...` form Node's ESM
  // loader actually requires. The entry-file argument (`mainPath`) does NOT
  // go through this path — Node's CLI normalizes a plain OS path there.
  const tsxLoaderSpecifier = pathToFileURL(opts.tsxLoaderPath ?? DEFAULT_TSX_LOADER).href;

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (bot.claude_bin !== undefined) env.CLAUDE_BIN = bot.claude_bin;
  if (bot.claude_args !== undefined) env.CLAUDE_ARGS = bot.claude_args;

  const child: ChildProcessWithoutNullStreams = spawn(nodeBin, ["--import", tsxLoaderSpecifier, mainPath], {
    cwd: bot.workspace,
    env,
    windowsHide: true,
  });

  const listeners: { [K in HolderEvent]: Array<(...args: never[]) => void> } = {
    injected: [],
    "pty-error": [],
    "pty-exit": [],
    exit: [],
  };
  function emit<K extends HolderEvent>(event: K, ...args: unknown[]): void {
    for (const cb of listeners[event]) (cb as (...a: unknown[]) => void)(...args);
  }

  let rpcSeq = 0;
  const pendingRpc = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

  function writeRequest(method: string, params: unknown): number {
    const id = ++rpcSeq;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return id;
  }

  const rl = createInterface({ input: child.stdout });
  rl.on("line", line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // malformed line from the child — not our contract to enforce here, just drop it
    }
    if (typeof msg.method === "string" && !("id" in msg)) {
      // Event (no id): pty-exit / pty-error / injected.
      const params = msg.params as Record<string, unknown> | undefined;
      if (msg.method === "injected" && params && typeof params.id === "string") {
        emit("injected", params.id);
      } else if (msg.method === "pty-error" && params && typeof params.message === "string") {
        emit("pty-error", params.message);
      } else if (msg.method === "pty-exit" && params) {
        emit("pty-exit", { code: Number(params.code ?? 0), signal: (params.signal as number | null) ?? null });
      }
      return;
    }
    if (typeof msg.id === "number" && pendingRpc.has(msg.id)) {
      const entry = pendingRpc.get(msg.id)!;
      pendingRpc.delete(msg.id);
      if ("error" in msg) entry.reject(new Error(String((msg.error as { message?: string })?.message ?? "holder RPC error")));
      else entry.resolve();
    }
  });

  child.on("exit", (code, signal) => {
    emit("exit", code, signal);
  });
  child.stdin.on("error", () => {
    /* EPIPE etc. once the child is gone — nothing to do, `exit`/`pty-exit` cover the real signal */
  });

  return {
    inject(stepId, text, submit) {
      writeRequest("inject", { id: stepId, text, submit });
    },
    injectSlash(stepId, command, confirmAfterMs) {
      const params: Record<string, unknown> = { id: stepId, command };
      if (confirmAfterMs !== undefined) params.confirmAfterMs = confirmAfterMs;
      writeRequest("inject-slash", params);
    },
    shutdown() {
      return new Promise<void>((resolve, reject) => {
        const id = writeRequest("shutdown", undefined);
        pendingRpc.set(id, { resolve, reject });
      });
    },
    forceKill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    },
    on(event: HolderEvent, cb: (...args: never[]) => void) {
      listeners[event].push(cb);
    },
  };
}

export type SpawnHolderFn = (bot: BotConfig, opts?: SpawnHolderOptions) => HolderHandle;

// ---------------------------------------------------------------------------
// BotSupervisor
// ---------------------------------------------------------------------------

export type HolderState = "starting" | "running" | "dead" | "restarting";

export interface SupervisorStatus {
  holder: HolderState;
  queue: number;
  awaiting_barrier: boolean;
  last_ack_s: number | null;
  restarts: number;
  /** ALARM (perilaku brief: "timeout → lepaskan + set ALARM doctor, BUKAN diam") — sticky until a fresh barrier successfully arms. */
  barrier_alarm: boolean;
  /**
   * I2 fix — doctor-visible trail: true once `stop()` had to escalate to a
   * SIGKILL because the holder never acked the graceful shutdown RPC nor
   * reported a native exit within the grace window (the wedged-holder
   * case). In the rare event the process is STILL alive even after SIGKILL,
   * this is how the doctor learns a force-kill was necessary rather than
   * silently trusting a `holder: 'dead'` that never got OS-level
   * confirmation.
   */
  force_killed: boolean;
}

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

function unref(handle: { unref?: () => void } | undefined): void {
  handle?.unref?.();
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => {
    const h = setTimeout(cb, ms);
    unref(h as unknown as { unref?: () => void });
    return h;
  },
  clearTimeout: h => clearTimeout(h),
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    unref(h as unknown as { unref?: () => void });
    return h;
  },
  clearInterval: h => clearInterval(h),
};

export interface BotSupervisorOptions {
  bot: BotConfig;
  db: Database;
  spawnHolder?: SpawnHolderFn;
  clock?: Clock;
  /** Base backoff (ms) for the first unexpected-death restart; doubles each subsequent restart. Default 1000ms. */
  backoffBaseMs?: number;
  /** Backoff cap. Default 30_000ms. */
  backoffMaxMs?: number;
  /** OS force-kill fallback window — README's "supervisor must keep its own ~5s force-kill timeout". Default 5000ms. */
  forceKillTimeoutMs?: number;
  /** Injection-queue poll interval. Default `QUEUE_POLL_MS` (200ms). */
  queuePollMs?: number;
  /** Injection-queue tuning passthrough (tests only — production uses the module defaults). */
  minGapMs?: number;
  postInjectionDelayMs?: number;
  clearBarrierTimeoutMs?: number;
  maxAttempts?: number;
}

/**
 * One bot's whole supervision unit: holder lifecycle (spawn/restart/backoff/
 * shutdown) + its `InjectionQueue`. `clearSession`/`onSessionStarted` are the
 * two public entry points recon-hooks.md §B's contract calls for (H1 will
 * wire the SessionStart hook to `onSessionStarted` in a later task — this
 * phase only exposes it).
 */
export class BotSupervisor {
  readonly queue: InjectionQueue;
  private readonly bot: BotConfig;
  private readonly db: Database;
  private readonly spawnHolderFn: SpawnHolderFn;
  private readonly clock: Clock;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly forceKillTimeoutMs: number;
  private readonly queuePollMs: number;

  private holder: HolderHandle | null = null;
  private holderState: HolderState = "starting";
  private restarts = 0;
  private shuttingDown = false;
  private restartTimer: ReturnType<Clock["setTimeout"]> | null = null;
  private pollTimer: ReturnType<Clock["setInterval"]> | null = null;
  /** I2 fix — see `SupervisorStatus.force_killed`'s docstring. */
  private forceKilled = false;

  constructor(opts: BotSupervisorOptions) {
    this.bot = opts.bot;
    this.db = opts.db;
    this.spawnHolderFn = opts.spawnHolder ?? spawnRealHolder;
    this.clock = opts.clock ?? realClock;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.forceKillTimeoutMs = opts.forceKillTimeoutMs ?? 5_000;
    this.queuePollMs = opts.queuePollMs ?? 200;

    this.queue = new InjectionQueue({
      dispatch: (stepId, unit) => this.dispatchToHolder(stepId, unit),
      now: () => this.clock.now(),
      minGapMs: opts.minGapMs,
      postInjectionDelayMs: opts.postInjectionDelayMs,
      clearBarrierTimeoutMs: opts.clearBarrierTimeoutMs,
      maxAttempts: opts.maxAttempts,
    });
  }

  get botId(): string {
    return this.bot.id;
  }

  /** Spawn the holder and start the queue's poll loop. */
  start(): void {
    this.spawn();
    this.pollTimer = this.clock.setInterval(() => {
      // Only drive the queue while a holder is actually attached — items
      // simply wait (state stays 'queued'/'sent') across a restart/backoff
      // window rather than being dispatched into thin air.
      if (this.holder && this.holderState === "running") this.queue.tick(this.clock.now());
    }, this.queuePollMs);
  }

  private spawn(): void {
    this.holderState = "starting";
    const holder = this.spawnHolderFn(this.bot);
    holder.on("injected", id => this.queue.onInjected(id, this.clock.now()));
    holder.on("pty-error", message => {
      // pty-error carries no id (ipc.ts's `PtyErrorEvent` — message only):
      // blame whichever step is currently in flight, if any.
      this.queue.resetInFlight(`pty-error: ${message}`, this.clock.now());
    });
    holder.on("pty-exit", () => this.handleUnexpectedDeath("holder pty-exit"));
    holder.on("exit", () => this.handleUnexpectedDeath("holder process exit"));
    this.holder = holder;
    this.holderState = "running";
  }

  private dispatchToHolder(stepId: string, unit: BatchSubItem): void {
    if (!this.holder) return; // shouldn't happen (poll loop gates on holder presence) — defensive no-op
    if (unit.kind === "slash") this.holder.injectSlash(stepId, unit.payload);
    else this.holder.inject(stepId, unit.payload, true);
  }

  private handleUnexpectedDeath(reason: string): void {
    if (this.holderState === "dead" || this.shuttingDown) return; // already handled / intentional stop
    this.holderState = "dead";
    this.queue.resetInFlight(reason, this.clock.now());
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.shuttingDown) return;
    this.holderState = "restarting";
    const delay = Math.min(this.backoffBaseMs * 2 ** this.restarts, this.backoffMaxMs);
    this.restarts += 1;
    this.restartTimer = this.clock.setTimeout(() => {
      this.restartTimer = null;
      this.spawn();
    }, delay);
  }

  /**
   * Graceful shutdown: RPC `shutdown`, raced against the OS-level force-kill
   * fallback (README's "~5s" contract). Idempotent.
   *
   * I2 fix: previously, once the grace window elapsed without an RPC ack,
   * this called `holder.forceKill()` (a plain SIGTERM) and immediately set
   * `holderState = 'dead'` — a holder wedged badly enough to already be
   * ignoring the graceful shutdown RPC can just as easily ignore SIGTERM
   * too, leaving the real OS process (and its node-pty grandchild) orphaned
   * while the doctor reports 'dead'. Now: the grace window is a single ask
   * for EITHER an RPC ack OR a native `exit`; if neither happened by the
   * time it elapses, escalate straight to `SIGKILL` (unignorable at the OS
   * level — there is no value in re-trying SIGTERM first, since a process
   * that ignored the in-band graceful request for the whole grace window
   * was never going to be moved by an out-of-band SIGTERM either). If the
   * holder already acked gracefully (or already exited on its own) within
   * the window, no force-kill is sent at all.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      this.clock.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.pollTimer) {
      this.clock.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const holder = this.holder;
    if (!holder) return;

    let exited = false;
    const exitedPromise = new Promise<void>(resolve => {
      holder.on("exit", () => {
        exited = true;
        resolve();
      });
    });

    let ackSettled = false;
    await Promise.race([
      holder
        .shutdown()
        .then(() => {
          ackSettled = true;
        })
        .catch(() => {
          /* holder answered with an error, or the pipe died mid-request — the escalation below covers both */
        }),
      exitedPromise, // the OS process may report exit on its own before either the ack or the grace timer
      new Promise<void>(resolve => {
        this.clock.setTimeout(resolve, this.forceKillTimeoutMs);
      }),
    ]);

    if (!ackSettled && !exited) {
      holder.forceKill("SIGKILL");
      this.forceKilled = true;
    }
    this.holderState = "dead";
  }

  /**
   * `sessions.lifecycle='resetting'` (state) -> enqueue `/clear` -> barrier
   * armed once the holder acks the keystroke, held until `onSessionStarted`
   * (or its safety timeout) — recon-hooks.md §B point 1.
   */
  clearSession(): EnqueueResult {
    setLatestSessionLifecycle(this.db, this.bot.id, "resetting");
    return this.queue.enqueueSlash("/clear", { source: "supervisor" });
  }

  /** H1 wires this to the SessionStart hook; exposed now as the barrier-release API + (via `queue`) available for an event subscriber later. */
  onSessionStarted(): void {
    this.queue.onSessionStarted(this.clock.now());
  }

  /** Convenience passthroughs so callers (X2 shim, cc-stub RPC handlers) don't need to reach into `.queue` directly. */
  enqueueSlash(command: string, source: InjectSource = "ai"): EnqueueResult {
    return this.queue.enqueueSlash(command, { source });
  }

  enqueueBatch(commands: readonly string[], source: InjectSource = "ai"): EnqueueResult {
    const subItems: BatchSubItem[] = commands.map(c => ({ kind: "slash", payload: c }));
    return this.queue.enqueueBatch(subItems, { source });
  }

  /** X2 shim's `enqueueInject` sink (`pending-consumer.ts`'s `InjectRequest`) — a legacy bot-lama command/batch payload landing on this pilot bot's queue. */
  enqueueFromLegacy(req: { id: string; commands: string[] }): void {
    if (req.commands.length === 0) return;
    if (req.commands.length === 1) {
      this.queue.enqueueSlash(req.commands[0]!, { source: "ai", id: req.id });
      return;
    }
    const subItems: BatchSubItem[] = req.commands.map(c => ({ kind: "slash", payload: c }));
    this.queue.enqueueBatch(subItems, { source: "ai", id: req.id });
  }

  status(): SupervisorStatus {
    return {
      holder: this.holderState,
      queue: this.queue.list().length,
      awaiting_barrier: this.queue.isAwaitingBarrier(),
      last_ack_s: this.queue.lastAckAgeS(this.clock.now()),
      restarts: this.restarts,
      barrier_alarm: this.queue.barrierAlarm(),
      force_killed: this.forceKilled,
    };
  }
}

// ---------------------------------------------------------------------------
// startSupervisors — per-config-bot factory, mirrors adapters/telegram.ts's
// `startTelegramAdapters` shape (pollers/statuses/stopAll).
// ---------------------------------------------------------------------------

export interface StartSupervisorsDeps {
  spawnHolder?: SpawnHolderFn;
  clock?: Clock;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  forceKillTimeoutMs?: number;
  queuePollMs?: number;
}

export interface SupervisorsHandle {
  supervisors: ReadonlyMap<string, BotSupervisor>;
  /** Snapshot for `doctorReport`'s `supervisors` component. */
  statuses(): Record<string, SupervisorStatus>;
  stopAll(): Promise<void>;
}

export function startSupervisors(
  config: { bots: readonly BotConfig[] },
  db: Database,
  deps: StartSupervisorsDeps = {},
): SupervisorsHandle {
  const supervisors = new Map<string, BotSupervisor>();
  for (const bot of config.bots) {
    const supervisor = new BotSupervisor({ bot, db, ...deps });
    supervisor.start();
    supervisors.set(bot.id, supervisor);
  }
  return {
    supervisors,
    statuses(): Record<string, SupervisorStatus> {
      const out: Record<string, SupervisorStatus> = {};
      for (const [botId, s] of supervisors) out[botId] = s.status();
      return out;
    },
    async stopAll(): Promise<void> {
      await Promise.all([...supervisors.values()].map(s => s.stop()));
    },
  };
}

/** Re-exported so callers building a legacy inject-request id don't need their own uuid import. */
export { randomUUID };
