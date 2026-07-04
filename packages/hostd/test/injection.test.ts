import { describe, expect, test } from "bun:test";
import {
  InjectionGate,
  InjectionQueue,
  MAX_INJECT_ATTEMPTS,
  STEP_ACK_TIMEOUT_MS,
  guardSlashCommand,
  type BatchSubItem,
} from "../src/supervisor/injection";

// ---------------------------------------------------------------------------
// guardSlashCommand (SEC-3 fix + telegram-layer + /effort source guard)
// ---------------------------------------------------------------------------

describe("guardSlashCommand", () => {
  test("accepts a plain slash command", () => {
    expect(guardSlashCommand("/clear")).toEqual({ ok: true });
  });

  test("accepts a namespaced command with args", () => {
    expect(guardSlashCommand("/telegram:notify-user hello world")).toEqual({ ok: true });
  });

  test("rejects a command not starting with a lowercase letter after /", () => {
    expect(guardSlashCommand("/Clear").ok).toBe(false);
    expect(guardSlashCommand("/1clear").ok).toBe(false);
  });

  test("rejects missing leading slash", () => {
    expect(guardSlashCommand("clear").ok).toBe(false);
  });

  test("SEC-3: rejects control characters in the argument tail", () => {
    expect(guardSlashCommand("/rename foo\x00bar").ok).toBe(false);
    expect(guardSlashCommand("/rename foo\nbar").ok).toBe(false);
    expect(guardSlashCommand("/rename foo\x1bbar").ok).toBe(false);
  });

  // M5: `\r` (carriage return) is its own explicit case — easy to miss since
  // it's neither `\n` nor an obviously "weird" control byte like ESC/NUL,
  // but it's just as capable of smuggling extra keystrokes into the PTY
  // (e.g. faking an Enter on some terminals) if the argument-tail regex
  // let it through.
  test("SEC-3: rejects \\r (carriage return) specifically in the argument tail", () => {
    expect(guardSlashCommand("/rename foo\rbar").ok).toBe(false);
    expect(guardSlashCommand("/rename foo\r").ok).toBe(false);
    expect(guardSlashCommand("/rename \r").ok).toBe(false);
  });

  test("rejects overlong command+argument (total budget is 1 + 64 + 256)", () => {
    // The optional argument group has no leading-whitespace requirement, so
    // a run of plain letters can spill from the "command word" slot into the
    // argument slot — total allowed length is 1 (word first char) + 63 (rest
    // of word) + 256 (argument) = 320 chars after the leading '/'. Anything
    // beyond that must be rejected.
    expect(guardSlashCommand("/" + "a".repeat(320)).ok).toBe(true);
    expect(guardSlashCommand("/" + "a".repeat(321)).ok).toBe(false);
    expect(guardSlashCommand("/x " + "a".repeat(300)).ok).toBe(false); // argument alone (300) exceeds 256
  });

  test("blocks telegram-layer commands regardless of source", () => {
    const r1 = guardSlashCommand("/new idle");
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toMatch(/telegram-layer/);

    expect(guardSlashCommand("/switch", "supervisor").ok).toBe(false);
    expect(guardSlashCommand("/delete").ok).toBe(false);
  });

  test("/effort blocked from AI/bus path, allowed from supervisor path", () => {
    const asAi = guardSlashCommand("/effort high");
    expect(asAi.ok).toBe(false);
    const asSupervisor = guardSlashCommand("/effort high", "supervisor");
    expect(asSupervisor).toEqual({ ok: true });
  });

  test("/clear and /rename are NOT telegram-layer-blocked (CC-native)", () => {
    expect(guardSlashCommand("/clear")).toEqual({ ok: true });
    expect(guardSlashCommand("/rename my-session")).toEqual({ ok: true });
    expect(guardSlashCommand("/resume abc-123")).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// InjectionGate (ported from wrapper/src/injection-gate.ts)
// ---------------------------------------------------------------------------

describe("InjectionGate", () => {
  const TIMEOUT = 1_000;

  test("not blocked initially", () => {
    const gate = new InjectionGate(TIMEOUT);
    expect(gate.isBlocked(0)).toBe(false);
  });

  test("holdFor blocks until the deadline", () => {
    const gate = new InjectionGate(TIMEOUT);
    gate.holdFor(500, 0);
    expect(gate.isBlocked(400)).toBe(true);
    expect(gate.isBlocked(500)).toBe(false);
  });

  test("holdFor takes the max of overlapping holds", () => {
    const gate = new InjectionGate(TIMEOUT);
    gate.holdFor(500, 0);
    gate.holdFor(100, 0); // shorter — should not shrink the window
    expect(gate.isBlocked(499)).toBe(true);
  });

  test("clear barrier blocks until released", () => {
    const gate = new InjectionGate(TIMEOUT);
    gate.beginClearBarrier(0);
    expect(gate.isBlocked(10)).toBe(true);
    gate.releaseClearBarrier(50, 100);
    expect(gate.clearBarrierActive(100)).toBe(false);
    expect(gate.isBlocked(149)).toBe(true); // settle window
    expect(gate.isBlocked(150)).toBe(false);
  });

  test("clear barrier force-releases after its timeout", () => {
    const gate = new InjectionGate(1_000);
    gate.beginClearBarrier(0);
    expect(gate.clearBarrierActive(999)).toBe(true);
    expect(gate.clearBarrierActive(1_001)).toBe(false);
    expect(gate.isBlocked(1_001)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InjectionQueue
// ---------------------------------------------------------------------------

interface HarnessOverrides {
  minGapMs?: number;
  postInjectionDelayMs?: number;
  clearBarrierTimeoutMs?: number;
  maxAttempts?: number;
  stepAckTimeoutMs?: number;
}

interface Harness {
  queue: InjectionQueue;
  sent: Array<{ stepId: string; unit: BatchSubItem }>;
  dead: Array<{ item: unknown; reason: string }>;
  readonly barrierTimeouts: number;
  clock: { now: number };
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const clock = { now: 0 };
  const sent: Harness["sent"] = [];
  const dead: Harness["dead"] = [];
  let barrierTimeouts = 0;
  const queue = new InjectionQueue({
    dispatch: (stepId, unit) => sent.push({ stepId, unit }),
    onDead: (item, reason) => dead.push({ item, reason }),
    onBarrierTimeout: () => {
      barrierTimeouts += 1;
    },
    now: () => clock.now,
    minGapMs: 100,
    postInjectionDelayMs: 50,
    clearBarrierTimeoutMs: 1_000,
    maxAttempts: 3,
    ...overrides,
  });
  return {
    queue,
    sent,
    dead,
    get barrierTimeouts() {
      return barrierTimeouts;
    },
    clock,
  };
}

describe("InjectionQueue — basic enqueue + dispatch + ack", () => {
  test("enqueueSlash validates via guardSlashCommand", () => {
    const h = makeHarness();
    const bad = h.queue.enqueueSlash("/new idle");
    expect(bad.ok).toBe(false);
    expect(h.queue.list().length).toBe(0);
  });

  test("dispatches the front item once the gate is open, then waits for ack", () => {
    const h = makeHarness();
    const r = h.queue.enqueueSlash("/clear".replace("/clear", "/help")); // avoid barrier semantics here
    expect(r.ok).toBe(true);
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.unit.payload).toBe("/help");
    // A second tick while a step is in flight must NOT dispatch again.
    h.queue.tick(1);
    expect(h.sent.length).toBe(1);
  });

  test("min-gap holds the gate between two items", () => {
    const h = makeHarness();
    h.queue.enqueueSlash("/help");
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    h.queue.onInjected(h.sent[0]!.stepId, 10); // ack arrives at t=10 -> settle holds until t=60
    h.queue.tick(50);
    expect(h.sent.length).toBe(1);
    h.queue.tick(200);
    expect(h.sent.length).toBe(2);
    h.queue.onInjected(h.sent[1]!.stepId, 200);
    expect(h.queue.list().length).toBe(0); // both acked and removed
  });

  test("last_ack_s reflects time since the most recent ack", () => {
    const h = makeHarness();
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    h.queue.onInjected(h.sent[0]!.stepId);
    expect(h.queue.lastAckAgeS(5_000)).toBe(5);
  });

  test("lastAckAgeS is null before any ack", () => {
    const h = makeHarness();
    expect(h.queue.lastAckAgeS(1000)).toBeNull();
  });
});

describe("InjectionQueue — batch atomicity", () => {
  test("a batch is one queue slot; its sub-items dispatch in order with nothing interleaved", () => {
    const h = makeHarness();
    const batch = h.queue.enqueueBatch([
      { kind: "slash", payload: "/help" },
      { kind: "slash", payload: "/rename foo" },
    ]);
    expect(batch.ok).toBe(true);
    // Enqueue a plain item AFTER the batch — it must not jump the queue.
    h.queue.enqueueSlash("/status");
    expect(h.queue.list().length).toBe(2); // batch (1 slot) + /status

    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.unit.payload).toBe("/help");
    h.queue.onInjected(h.sent[0]!.stepId);

    h.queue.tick(200);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.unit.payload).toBe("/rename foo"); // second batch sub-item, NOT /status
    h.queue.onInjected(h.sent[1]!.stepId);
    expect(h.queue.list().length).toBe(1); // batch fully acked and removed; /status remains

    h.queue.tick(400);
    expect(h.sent.length).toBe(3);
    expect(h.sent[2]!.unit.payload).toBe("/status");
  });

  test("enqueueBatch rejects empty or oversized batches", () => {
    const h = makeHarness();
    expect(h.queue.enqueueBatch([]).ok).toBe(false);
    const tooBig = Array.from({ length: 9 }, () => ({ kind: "slash", payload: "/help" }) as BatchSubItem);
    expect(h.queue.enqueueBatch(tooBig).ok).toBe(false);
  });

  test("enqueueBatch validates every slash sub-item", () => {
    const h = makeHarness();
    const r = h.queue.enqueueBatch([{ kind: "slash", payload: "/help" }, { kind: "slash", payload: "/new x" }]);
    expect(r.ok).toBe(false);
    expect(h.queue.list().length).toBe(0);
  });
});

describe("InjectionQueue — clear barrier", () => {
  test("/clear arms the barrier on ack; nothing else dispatches until onSessionStarted", () => {
    const h = makeHarness();
    h.queue.enqueueSlash("/clear");
    h.queue.enqueueSlash("/status");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]!.unit.payload).toBe("/clear");
    h.queue.onInjected(h.sent[0]!.stepId, 0);
    expect(h.queue.isAwaitingBarrier()).toBe(true);

    // Barrier open — /status must NOT dispatch even much later, until released.
    h.queue.tick(500);
    expect(h.sent.length).toBe(1);

    h.queue.onSessionStarted(500);
    expect(h.queue.isAwaitingBarrier()).toBe(false);
    expect(h.queue.list().length).toBe(1); // /clear item consumed, /status remains

    // Settle delay (postInjectionDelayMs=50) still applies after release.
    h.queue.tick(510);
    expect(h.sent.length).toBe(1);
    h.queue.tick(600);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.unit.payload).toBe("/status");
  });

  test("onSessionStarted is a safe no-op when nothing is awaiting the barrier", () => {
    const h = makeHarness();
    expect(() => h.queue.onSessionStarted()).not.toThrow();
    expect(h.queue.isAwaitingBarrier()).toBe(false);
  });

  test("barrier force-releases via timeout and sets the ALARM, draining the queue anyway", () => {
    const h = makeHarness({ clearBarrierTimeoutMs: 1_000 });
    h.queue.enqueueSlash("/clear");
    h.queue.enqueueSlash("/status");
    h.queue.tick(0);
    h.queue.onInjected(h.sent[0]!.stepId);
    expect(h.queue.barrierAlarm()).toBe(false);

    h.queue.tick(500); // still within timeout
    expect(h.sent.length).toBe(1);
    expect(h.queue.barrierAlarm()).toBe(false);

    h.queue.tick(1_500); // past the 1000ms timeout
    expect(h.queue.barrierAlarm()).toBe(true);
    expect(h.barrierTimeouts).toBe(1);
    expect(h.queue.isAwaitingBarrier()).toBe(false);

    // Queue keeps draining — /status should dispatch on a subsequent tick.
    h.queue.tick(1_700);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.unit.payload).toBe("/status");
  });

  test("a fresh /clear cycle clears a stale alarm from a previous timeout", () => {
    const h = makeHarness({ clearBarrierTimeoutMs: 100 });
    h.queue.enqueueSlash("/clear");
    h.queue.tick(0);
    h.queue.onInjected(h.sent[0]!.stepId);
    h.queue.tick(300);
    expect(h.queue.barrierAlarm()).toBe(true);

    h.queue.enqueueSlash("/clear");
    h.queue.tick(500);
    expect(h.sent.length).toBe(2);
    h.queue.onInjected(h.sent[1]!.stepId, 500);
    expect(h.queue.barrierAlarm()).toBe(false); // fresh arm resets the sticky alarm
  });

  test("/clear inside a batch pauses only the remaining sub-items, not other queue items", () => {
    const h = makeHarness();
    h.queue.enqueueBatch([
      { kind: "slash", payload: "/clear" },
      { kind: "slash", payload: "/status" },
    ]);
    h.queue.tick(0);
    expect(h.sent[0]!.unit.payload).toBe("/clear");
    h.queue.onInjected(h.sent[0]!.stepId);
    expect(h.queue.isAwaitingBarrier()).toBe(true);

    h.queue.tick(50);
    expect(h.sent.length).toBe(1); // still waiting on the barrier

    h.queue.onSessionStarted();
    h.queue.tick(200);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.unit.payload).toBe("/status"); // batch's own second sub-item
  });
});

describe("InjectionQueue — retry + dead-letter (IDEA-2)", () => {
  test("a failed step retries up to maxAttempts, then dead-letters visibly", () => {
    const h = makeHarness({ maxAttempts: 3 });
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    h.queue.onError(h.sent[0]!.stepId, "pty-error: boom 1");
    expect(h.queue.list().length).toBe(1); // still active, retrying

    h.queue.tick(200);
    expect(h.sent.length).toBe(2);
    h.queue.onError(h.sent[1]!.stepId, "pty-error: boom 2");
    expect(h.queue.list().length).toBe(1);
    expect(h.dead.length).toBe(0);

    h.queue.tick(400);
    expect(h.sent.length).toBe(3);
    h.queue.onError(h.sent[2]!.stepId, "pty-error: boom 3");
    expect(h.queue.list().length).toBe(0); // dead-lettered, removed from active queue
    expect(h.dead.length).toBe(1);
    expect(h.dead[0]!.reason).toBe("pty-error: boom 3");
  });

  test("onError for an unknown/stale stepId is ignored", () => {
    const h = makeHarness();
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(() => h.queue.onError("not-a-real-step", "whatever")).not.toThrow();
    expect(h.queue.list().length).toBe(1); // untouched
  });

  test("resetInFlight treats an in-flight step as an error (holder died mid-flight)", () => {
    const h = makeHarness({ maxAttempts: 2 });
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    h.queue.resetInFlight("holder pty exited unexpectedly");
    expect(h.queue.list().length).toBe(1); // one retry left

    h.queue.tick(200);
    h.queue.resetInFlight("holder pty exited unexpectedly again");
    expect(h.dead.length).toBe(1);
  });

  test("resetInFlight is a no-op when nothing is in flight", () => {
    const h = makeHarness();
    expect(() => h.queue.resetInFlight("nothing to reset")).not.toThrow();
  });

  test("onInjected for an unknown/stale stepId is ignored", () => {
    const h = makeHarness();
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(() => h.queue.onInjected("not-the-real-step-id")).not.toThrow();
    expect(h.queue.list().length).toBe(1); // untouched — still in flight
  });
});

describe("InjectionQueue — step-ack watchdog (I1: stuck-queue fix)", () => {
  test("a non-/clear step whose `injected` ack never arrives times out, retries, then dead-letters", () => {
    const h = makeHarness({ stepAckTimeoutMs: 30, minGapMs: 10, maxAttempts: 2 });
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);

    // The holder stays "alive" but never emits `injected` for this step and
    // never reports `pty-error` either — before the I1 fix this wedged
    // `pendingStep` forever and `tick()` early-returned on every subsequent
    // call, freezing the whole queue.
    h.queue.tick(29); // just short of the deadline — must not redispatch yet
    expect(h.sent.length).toBe(1);

    h.queue.tick(30); // deadline hit — treated like onError: attempt 1 of 2
    expect(h.queue.list().length).toBe(1); // still active, retrying
    expect(h.dead.length).toBe(0);

    h.queue.tick(40); // min-gap backoff cleared -> redispatch (attempt 2)
    expect(h.sent.length).toBe(2);
    expect(h.sent[1]!.stepId).not.toBe(h.sent[0]!.stepId); // M1: distinct per-attempt token

    // Second attempt also never acked -> deadline at 40+30=70 -> maxAttempts
    // (2) exhausted -> dead-lettered, visibly (IDEA-2), not silently dropped.
    h.queue.tick(70);
    expect(h.queue.list().length).toBe(0);
    expect(h.dead.length).toBe(1);
    expect(h.dead[0]!.reason).toMatch(/step-ack timeout/);
  });

  test("an `injected` ack arriving just before the deadline cancels the watchdog (success, no timeout)", () => {
    const h = makeHarness({ stepAckTimeoutMs: 30 });
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);

    h.queue.onInjected(h.sent[0]!.stepId, 29); // ack lands 1ms before the 30ms deadline
    expect(h.queue.list().length).toBe(0); // acked and removed — success
    expect(h.dead.length).toBe(0);

    // A later tick at/after what would have been the deadline must not
    // retroactively fire the (already-cancelled) watchdog.
    h.queue.tick(1_000);
    expect(h.dead.length).toBe(0);
  });

  test("/clear is exempt from the step-ack watchdog — it relies solely on the barrier timeout", () => {
    const h = makeHarness({ stepAckTimeoutMs: 10, clearBarrierTimeoutMs: 1_000, minGapMs: 5 });
    h.queue.enqueueSlash("/clear");
    h.queue.tick(0);
    expect(h.sent.length).toBe(1);
    h.queue.onInjected(h.sent[0]!.stepId, 0); // keystroke acked -> barrier armed
    expect(h.queue.isAwaitingBarrier()).toBe(true);

    // Well past the (short) step-ack timeout, but the barrier timeout is
    // much longer — must NOT have been dead-lettered by the step watchdog.
    h.queue.tick(500);
    expect(h.dead.length).toBe(0);
    expect(h.queue.isAwaitingBarrier()).toBe(true);
  });
});

describe("InjectionQueue — per-attempt token (M1: retry race fix)", () => {
  test("a stale `injected` echo from an earlier, already-failed attempt is ignored once a retry is in flight", () => {
    const h = makeHarness({ maxAttempts: 3, minGapMs: 10 });
    h.queue.enqueueSlash("/help");
    h.queue.tick(0);
    const firstAttemptStepId = h.sent[0]!.stepId;

    h.queue.onError(firstAttemptStepId, "pty-error: boom 1"); // triggers a retry
    expect(h.queue.list().length).toBe(1); // still active

    h.queue.tick(20);
    expect(h.sent.length).toBe(2);
    const secondAttemptStepId = h.sent[1]!.stepId;
    expect(secondAttemptStepId).not.toBe(firstAttemptStepId); // distinct per-attempt tokens

    // A late/duplicate `injected` echo for the FIRST (already-failed and
    // retried) attempt arrives after the second attempt is already in
    // flight. Before the M1 fix both attempts shared the exact same base
    // stepId, so this stale echo would spuriously match the retry's
    // `pendingStep` and incorrectly ack it. It must now be ignored.
    h.queue.onInjected(firstAttemptStepId, 25);
    expect(h.queue.list().length).toBe(1); // still in flight — NOT acked by the stale echo
    expect(h.dead.length).toBe(0);

    // The real (second-attempt) ack still completes the item correctly.
    h.queue.onInjected(secondAttemptStepId, 26);
    expect(h.queue.list().length).toBe(0);
  });

  test("batch sub-item retries also get distinct per-attempt tokens", () => {
    const h = makeHarness({ maxAttempts: 3, minGapMs: 10 });
    h.queue.enqueueBatch([{ kind: "slash", payload: "/help" }]);
    h.queue.tick(0);
    const firstAttemptStepId = h.sent[0]!.stepId;

    h.queue.onError(firstAttemptStepId, "pty-error: boom");
    h.queue.tick(20);
    const secondAttemptStepId = h.sent[1]!.stepId;
    expect(secondAttemptStepId).not.toBe(firstAttemptStepId);

    h.queue.onInjected(firstAttemptStepId, 25); // stale — must be ignored
    expect(h.queue.list().length).toBe(1);
    h.queue.onInjected(secondAttemptStepId, 26);
    expect(h.queue.list().length).toBe(0);
  });
});

describe("InjectionQueue — enqueueText", () => {
  test("rejects empty text", () => {
    const h = makeHarness();
    expect(h.queue.enqueueText("").ok).toBe(false);
  });

  test("dispatches and acks like a slash item", () => {
    const h = makeHarness();
    h.queue.enqueueText("hello agent-bus prompt");
    h.queue.tick(0);
    expect(h.sent[0]!.unit).toEqual({ kind: "text", payload: "hello agent-bus prompt" });
    h.queue.onInjected(h.sent[0]!.stepId);
    expect(h.queue.list().length).toBe(0);
  });
});

// Sanity: MAX_INJECT_ATTEMPTS export exists and matches the harness default expectations.
test("MAX_INJECT_ATTEMPTS default export sanity", () => {
  expect(MAX_INJECT_ATTEMPTS).toBeGreaterThan(0);
});

// Sanity: STEP_ACK_TIMEOUT_MS (I1) export exists and is a sane production default.
test("STEP_ACK_TIMEOUT_MS default export sanity", () => {
  expect(STEP_ACK_TIMEOUT_MS).toBeGreaterThan(0);
});
