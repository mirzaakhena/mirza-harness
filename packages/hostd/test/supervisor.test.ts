import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/state/db";
import type { BotConfig } from "../src/config";
import {
  BotSupervisor,
  startSupervisors,
  type Clock,
  type HolderHandle,
  type SpawnHolderFn,
} from "../src/supervisor/supervisor";

/**
 * Task S1 — supervisor.ts tests. Per the brief: "test JANGAN spawn holder
 * Node sungguhan" — `spawnHolder` is always a fake, in-memory `HolderHandle`
 * here. This suite exercises spawn/restart/backoff, IPC event wiring into
 * the injection queue, the shutdown race (RPC ack vs. OS force-kill
 * fallback), and `clearSession`/`onSessionStarted`. A real-holder
 * integration script is a separate concern (mirrors pty-holder's own
 * `test-integration.mjs`), not part of this `bun test` suite.
 */

// ---------------------------------------------------------------------------
// Fake clock — deterministic timer control (no real waiting in tests).
// ---------------------------------------------------------------------------

interface TimerEntry {
  id: number;
  repeat: boolean;
  ms: number;
  cb: () => void;
  nextAt: number;
}

class FakeClock implements Clock {
  private t = 0;
  private timers: TimerEntry[] = [];
  private seq = 0;

  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = ++this.seq;
    this.timers.push({ id, repeat: false, ms, cb, nextAt: this.t + ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.timers = this.timers.filter(entry => entry.id !== (handle as unknown as number));
  }
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = ++this.seq;
    this.timers.push({ id, repeat: true, ms, cb, nextAt: this.t + ms });
    return id as unknown as ReturnType<typeof setInterval>;
  }
  clearInterval(handle: ReturnType<typeof setInterval>): void {
    this.timers = this.timers.filter(entry => entry.id !== (handle as unknown as number));
  }

  /** Advance simulated time, firing every due timer/interval in order (intervals reschedule; may fire >1x on a big jump). */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers.filter(entry => entry.nextAt <= target).sort((a, b) => a.nextAt - b.nextAt)[0];
      if (!due) break;
      this.t = due.nextAt;
      if (due.repeat) due.nextAt += due.ms;
      else this.timers = this.timers.filter(entry => entry.id !== due.id);
      due.cb();
    }
    this.t = target;
  }
}

// ---------------------------------------------------------------------------
// Fake holder — in-memory HolderHandle, no real process/node-pty anywhere.
// ---------------------------------------------------------------------------

type ListenerMap = {
  injected: Array<(id: string) => void>;
  "pty-error": Array<(message: string) => void>;
  "pty-exit": Array<(info: { code: number; signal: number | null }) => void>;
  exit: Array<(code: number | null, signal: NodeJS.Signals | null) => void>;
};

class FakeHolder implements HolderHandle {
  readonly injectCalls: Array<{ stepId: string; command: string; kind: "slash" | "text"; confirmAfterMs?: number }> = [];
  shutdownBehavior: "resolve" | "hang" | "reject" = "resolve";
  forceKillCalled = false;
  /** I2 fix: last signal `forceKill` was invoked with, so tests can assert the SIGTERM->SIGKILL escalation. */
  forceKillSignal: NodeJS.Signals | undefined;
  private readonly listeners: ListenerMap = { injected: [], "pty-error": [], "pty-exit": [], exit: [] };

  inject(stepId: string, text: string): void {
    this.injectCalls.push({ stepId, command: text, kind: "text" });
  }
  injectSlash(stepId: string, command: string, confirmAfterMs?: number): void {
    this.injectCalls.push({ stepId, command, kind: "slash", confirmAfterMs });
  }
  shutdown(): Promise<void> {
    if (this.shutdownBehavior === "resolve") return Promise.resolve();
    if (this.shutdownBehavior === "reject") return Promise.reject(new Error("holder shutdown RPC failed"));
    return new Promise<void>(() => {}); // hang forever — exercises the force-kill fallback
  }
  forceKill(signal?: NodeJS.Signals): void {
    this.forceKillCalled = true;
    this.forceKillSignal = signal;
  }
  on(event: keyof ListenerMap, cb: (...args: never[]) => void): void {
    (this.listeners[event] as Array<(...args: never[]) => void>).push(cb);
  }
  emitInjected(id: string): void {
    for (const cb of this.listeners.injected) cb(id);
  }
  emitPtyError(message: string): void {
    for (const cb of this.listeners["pty-error"]) cb(message);
  }
  emitPtyExit(): void {
    for (const cb of this.listeners["pty-exit"]) cb({ code: 1, signal: null });
  }
  emitExit(): void {
    for (const cb of this.listeners.exit) cb(null, null);
  }
}

function fakeSpawnFactory(): { spawnHolder: SpawnHolderFn; instances: FakeHolder[] } {
  const instances: FakeHolder[] = [];
  const spawnHolder: SpawnHolderFn = () => {
    const h = new FakeHolder();
    instances.push(h);
    return h;
  };
  return { spawnHolder, instances };
}

function makeBot(id = "bot-test"): BotConfig {
  return { id, telegram_token: "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", workspace: "C:/ws/" + id };
}

function makeSupervisor(overrides: {
  db?: Database;
  bot?: BotConfig;
  backoffBaseMs?: number;
  forceKillTimeoutMs?: number;
  queuePollMs?: number;
  minGapMs?: number;
  maxAttempts?: number;
} = {}) {
  const clock = new FakeClock();
  const { spawnHolder, instances } = fakeSpawnFactory();
  const db = overrides.db ?? openDb(":memory:");
  const bot = overrides.bot ?? makeBot();
  const supervisor = new BotSupervisor({
    bot,
    db,
    spawnHolder,
    clock,
    backoffBaseMs: overrides.backoffBaseMs ?? 1_000,
    forceKillTimeoutMs: overrides.forceKillTimeoutMs ?? 5_000,
    queuePollMs: overrides.queuePollMs ?? 200,
    minGapMs: overrides.minGapMs,
    maxAttempts: overrides.maxAttempts,
  });
  return { supervisor, clock, instances, db, bot };
}

// ---------------------------------------------------------------------------
// Spawn + status
// ---------------------------------------------------------------------------

describe("BotSupervisor — spawn + status", () => {
  test("start() spawns via the fake factory; status().holder is 'running'", () => {
    const { supervisor, instances } = makeSupervisor();
    supervisor.start();
    expect(instances.length).toBe(1);
    expect(supervisor.status()).toEqual({
      holder: "running",
      queue: 0,
      awaiting_barrier: false,
      last_ack_s: null,
      restarts: 0,
      barrier_alarm: false,
      force_killed: false,
    });
  });

  test("enqueueSlash dispatches into the holder once the poll loop ticks, and drains on ack", () => {
    const { supervisor, instances, clock } = makeSupervisor();
    supervisor.start();
    const r = supervisor.enqueueSlash("/status");
    expect(r.ok).toBe(true);
    expect(supervisor.status().queue).toBe(1);

    clock.advance(200); // one poll tick
    const holder = instances[0]!;
    expect(holder.injectCalls.length).toBe(1);
    expect(holder.injectCalls[0]!.command).toBe("/status");
    expect(holder.injectCalls[0]!.kind).toBe("slash");
    // M1 fix: the dispatched correlation id is the enqueue result's id PLUS
    // a monotonic per-attempt token suffix (`@0` for a first attempt) — no
    // longer the bare id verbatim.
    expect(holder.injectCalls[0]!.stepId).toBe(`${(r as { ok: true; id: string }).id}@0`);

    holder.emitInjected(holder.injectCalls[0]!.stepId);
    expect(supervisor.status().queue).toBe(0);
    expect(supervisor.status().last_ack_s).toBe(0);
  });

  test("SCAR-035: /effort dispatched with source:'supervisor' carries confirmAfterMs=500; other commands carry none", () => {
    const { supervisor, instances, clock } = makeSupervisor();
    supervisor.start();
    const r = supervisor.enqueueSlash("/effort high", "supervisor");
    expect(r.ok).toBe(true);
    clock.advance(200);
    const holder = instances[0]!;
    expect(holder.injectCalls[0]!.command).toBe("/effort high");
    expect(holder.injectCalls[0]!.confirmAfterMs).toBe(500);

    holder.emitInjected(holder.injectCalls[0]!.stepId);
    clock.advance(2_000); // clear the post-injection gate hold
    supervisor.enqueueSlash("/status");
    clock.advance(200);
    expect(holder.injectCalls[1]!.command).toBe("/status");
    expect(holder.injectCalls[1]!.confirmAfterMs).toBeUndefined();
  });

  test("enqueueSlash rejects an invalid/blocked command without touching the holder", () => {
    const { supervisor, instances, clock } = makeSupervisor();
    supervisor.start();
    const r = supervisor.enqueueSlash("/new idle");
    expect(r.ok).toBe(false);
    clock.advance(1000);
    expect(instances[0]!.injectCalls.length).toBe(0);
  });

  test("enqueueBatch produces one atomic queue slot dispatched over successive ticks", () => {
    const { supervisor, instances, clock } = makeSupervisor();
    supervisor.start();
    const r = supervisor.enqueueBatch(["/help", "/status"]);
    expect(r.ok).toBe(true);
    expect(supervisor.status().queue).toBe(1);

    clock.advance(200);
    const holder = instances[0]!;
    expect(holder.injectCalls.length).toBe(1);
    expect(holder.injectCalls[0]!.command).toBe("/help");
    holder.emitInjected(holder.injectCalls[0]!.stepId);

    clock.advance(2_000); // clear the min-gap/settle hold
    expect(holder.injectCalls.length).toBe(2);
    expect(holder.injectCalls[1]!.command).toBe("/status");
    holder.emitInjected(holder.injectCalls[1]!.stepId);
    expect(supervisor.status().queue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unexpected death -> backoff -> restart
// ---------------------------------------------------------------------------

describe("BotSupervisor — unexpected death, backoff, restart", () => {
  test("pty-exit marks the holder dead, then respawns after exponential backoff", () => {
    const { supervisor, instances, clock } = makeSupervisor({ backoffBaseMs: 1_000 });
    supervisor.start();
    expect(instances.length).toBe(1);

    instances[0]!.emitPtyExit();
    expect(supervisor.status().holder).toBe("restarting");
    expect(supervisor.status().restarts).toBe(1);

    clock.advance(999);
    expect(instances.length).toBe(1); // not yet — backoff base is 1000ms
    clock.advance(1);
    expect(instances.length).toBe(2); // respawned
    expect(supervisor.status().holder).toBe("running");

    // second death -> backoff doubles (2000ms)
    instances[1]!.emitPtyExit();
    expect(supervisor.status().restarts).toBe(2);
    clock.advance(1_999);
    expect(instances.length).toBe(2);
    clock.advance(1);
    expect(instances.length).toBe(3);
  });

  test("native 'exit' event (no pty-exit) also triggers restart", () => {
    const { supervisor, instances, clock } = makeSupervisor({ backoffBaseMs: 500 });
    supervisor.start();
    instances[0]!.emitExit();
    expect(supervisor.status().holder).toBe("restarting");
    clock.advance(500);
    expect(instances.length).toBe(2);
  });

  test("an in-flight injection is retried after the holder dies mid-flight", () => {
    const { supervisor, instances, clock } = makeSupervisor({ backoffBaseMs: 10, minGapMs: 5, maxAttempts: 3 });
    supervisor.start();
    supervisor.enqueueSlash("/status");
    clock.advance(200);
    expect(instances[0]!.injectCalls.length).toBe(1);

    instances[0]!.emitPtyExit(); // dies mid-flight, no injected/pty-error ever arrives
    clock.advance(10); // backoff -> respawn
    expect(instances.length).toBe(2);

    clock.advance(200); // poll tick against the NEW holder
    expect(instances[1]!.injectCalls.length).toBe(1); // retried against the new holder
    expect(supervisor.status().queue).toBe(1); // still active (not dead — only 1 failed attempt so far)
  });

  test("pty-error with no matching in-flight step is a harmless no-op (queue untouched)", () => {
    const { supervisor, instances } = makeSupervisor();
    supervisor.start();
    expect(() => instances[0]!.emitPtyError("spurious error, nothing in flight")).not.toThrow();
    expect(supervisor.status().queue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stop() — RPC shutdown vs. OS force-kill fallback
// ---------------------------------------------------------------------------

describe("BotSupervisor — stop()", () => {
  test("resolves once the holder's shutdown RPC acks, without force-killing", async () => {
    const { supervisor, instances } = makeSupervisor();
    supervisor.start();
    instances[0]!.shutdownBehavior = "resolve";
    await supervisor.stop();
    expect(instances[0]!.forceKillCalled).toBe(false);
    expect(supervisor.status().holder).toBe("dead");
    expect(supervisor.status().force_killed).toBe(false);
  });

  // I2 fix: a holder that ignores the graceful shutdown RPC for the whole
  // grace window is treated as wedged — escalate straight to SIGKILL
  // (unignorable at the OS level), not a plain default-signal kill().
  test("force-kills with SIGKILL after forceKillTimeoutMs when the holder never acks shutdown (I2)", async () => {
    const { supervisor, instances, clock } = makeSupervisor({ forceKillTimeoutMs: 5_000 });
    supervisor.start();
    instances[0]!.shutdownBehavior = "hang";
    const stopPromise = supervisor.stop();
    // Let the fallback timer fire — FakeClock timers are synchronous, so
    // this settles the race deterministically without a real 5s wait.
    clock.advance(5_000);
    await stopPromise;
    expect(instances[0]!.forceKillCalled).toBe(true);
    expect(instances[0]!.forceKillSignal).toBe("SIGKILL");
    expect(supervisor.status().holder).toBe("dead");
    expect(supervisor.status().force_killed).toBe(true); // doctor-visible trail (I2)
  });

  test("force-kills with SIGKILL when the holder's shutdown RPC rejects", async () => {
    const { supervisor, instances, clock } = makeSupervisor({ forceKillTimeoutMs: 5_000 });
    supervisor.start();
    instances[0]!.shutdownBehavior = "reject";
    const stopPromise = supervisor.stop();
    clock.advance(5_000);
    await stopPromise;
    // A rejected shutdown() never sets `ackSettled`, so the escalation still
    // runs (rejection is swallowed, not a substitute for the OS kill).
    expect(instances[0]!.forceKillCalled).toBe(true);
    expect(instances[0]!.forceKillSignal).toBe("SIGKILL");
    expect(supervisor.status().force_killed).toBe(true);
  });

  // I2 fix: a holder that exits normally (or acks gracefully) is never
  // additionally SIGKILLed — the escalation is reserved for the genuinely
  // wedged case, not a blanket kill on every stop().
  test("a holder that reports a native `exit` during the shutdown race is NOT SIGKILLed (I2)", async () => {
    const { supervisor, instances } = makeSupervisor();
    supervisor.start();
    instances[0]!.shutdownBehavior = "hang"; // RPC never acks...
    const stopPromise = supervisor.stop();
    instances[0]!.emitExit(); // ...but the OS process reports exit on its own before the grace window matters
    await stopPromise;
    expect(instances[0]!.forceKillCalled).toBe(false);
    expect(supervisor.status().holder).toBe("dead");
    expect(supervisor.status().force_killed).toBe(false);
  });

  test("stop() is idempotent and safe to call when never started", async () => {
    const { supervisor } = makeSupervisor();
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  test("stop() suppresses further restarts even if the holder dies during shutdown", async () => {
    const { supervisor, instances, clock } = makeSupervisor({ forceKillTimeoutMs: 1_000 });
    supervisor.start();
    instances[0]!.shutdownBehavior = "hang";
    const stopPromise = supervisor.stop();
    instances[0]!.emitPtyExit(); // race: holder dies while shutdown is pending
    clock.advance(1_000);
    await stopPromise;
    expect(instances.length).toBe(1); // no restart happened
  });
});

// ---------------------------------------------------------------------------
// clearSession / onSessionStarted
// ---------------------------------------------------------------------------

describe("BotSupervisor — clearSession + onSessionStarted (recon-hooks §B point 1)", () => {
  test("clearSession sets sessions.lifecycle='resetting' for the bot's latest row and enqueues /clear", () => {
    const db = openDb(":memory:");
    const bot = makeBot("bot-clear");
    db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?)`, [bot.id, bot.workspace]);
    db.run(`INSERT INTO sessions (id, bot_id, lifecycle, started_at) VALUES (?, ?, 'idle', ?)`, [
      "sess-1",
      bot.id,
      Math.floor(Date.now() / 1000),
    ]);

    const { supervisor, instances, clock } = makeSupervisor({ db, bot });
    supervisor.start();
    const r = supervisor.clearSession();
    expect(r.ok).toBe(true);

    const row = db.query(`SELECT lifecycle FROM sessions WHERE id = 'sess-1'`).get() as { lifecycle: string };
    expect(row.lifecycle).toBe("resetting");

    clock.advance(200);
    const holder = instances[0]!;
    expect(holder.injectCalls[0]!.command).toBe("/clear");
    holder.emitInjected(holder.injectCalls[0]!.stepId);
    expect(supervisor.status().awaiting_barrier).toBe(true);

    supervisor.onSessionStarted();
    expect(supervisor.status().awaiting_barrier).toBe(false);
  });

  test("clearSession with no existing session row is a safe no-op on the DB side, /clear still enqueued", () => {
    const { supervisor } = makeSupervisor();
    supervisor.start();
    const r = supervisor.clearSession();
    expect(r.ok).toBe(true);
    expect(supervisor.status().queue).toBe(1);
  });

  test("onSessionStarted is safe to call with nothing awaiting the barrier", () => {
    const { supervisor } = makeSupervisor();
    supervisor.start();
    expect(() => supervisor.onSessionStarted()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// enqueueFromLegacy — X2 shim's InjectRequest sink
// ---------------------------------------------------------------------------

describe("BotSupervisor — enqueueFromLegacy (X2 shim wiring)", () => {
  test("single command -> enqueueSlash", () => {
    const { supervisor } = makeSupervisor();
    supervisor.start();
    supervisor.enqueueFromLegacy({ id: "legacy-1", commands: ["/status"] });
    expect(supervisor.status().queue).toBe(1);
  });

  test("multiple commands -> one atomic batch slot", () => {
    const { supervisor } = makeSupervisor();
    supervisor.start();
    supervisor.enqueueFromLegacy({ id: "legacy-2", commands: ["/help", "/status"] });
    expect(supervisor.status().queue).toBe(1); // one slot, not two
  });

  test("empty commands array is a no-op", () => {
    const { supervisor } = makeSupervisor();
    supervisor.start();
    supervisor.enqueueFromLegacy({ id: "legacy-3", commands: [] });
    expect(supervisor.status().queue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// startSupervisors — multi-bot wiring (doctor's `statuses()` source)
// ---------------------------------------------------------------------------

describe("startSupervisors", () => {
  test("spawns one supervisor per configured bot and reports a statuses() map", () => {
    const db = openDb(":memory:");
    const { spawnHolder, instances } = fakeSpawnFactory();
    const clock = new FakeClock();
    const config = { bots: [makeBot("bot-a"), makeBot("bot-b")] };
    const handle = startSupervisors(config, db, { spawnHolder, clock });

    expect(handle.supervisors.size).toBe(2);
    expect(instances.length).toBe(2);
    const statuses = handle.statuses();
    expect(Object.keys(statuses).sort()).toEqual(["bot-a", "bot-b"]);
    expect(statuses["bot-a"]!.holder).toBe("running");
  });

  test("stopAll stops every supervisor", async () => {
    const db = openDb(":memory:");
    const { spawnHolder, instances } = fakeSpawnFactory();
    const clock = new FakeClock();
    const config = { bots: [makeBot("bot-a"), makeBot("bot-b")] };
    const handle = startSupervisors(config, db, { spawnHolder, clock });
    for (const h of instances) h.shutdownBehavior = "resolve";
    await handle.stopAll();
    for (const s of handle.supervisors.values()) expect(s.status().holder).toBe("dead");
  });
});
