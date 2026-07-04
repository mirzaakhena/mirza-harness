import { describe, expect, spyOn, test } from "bun:test";
import { createPoller, type PollerBot, type PollerStatus } from "../src/poller";

/**
 * grammy DIMOCK — tidak ada network nyata di test ini. `MockBot`
 * mengimplementasikan subset `PollerBot` yang dipakai poller, dgn perilaku
 * `start()` yang bisa diskrip per-panggilan (reject 409, resolve/onStart
 * lalu menggantung sampai stop() dipanggil, atau menggantung tanpa onStart).
 */
type StartBehavior = "reject-409" | "reject-other" | "run" | "hang";

class MockBot implements PollerBot {
  catch: ((err: unknown) => void) | undefined;
  startCalls = 0;
  stopCalls = 0;
  private index = 0;
  private pendingResolve: (() => void) | null = null;

  constructor(private behaviors: StartBehavior[]) {}

  use(): unknown {
    return undefined;
  }

  start(options?: { onStart?: (info: { username: string }) => void }): Promise<void> {
    this.startCalls++;
    const behavior = this.behaviors[this.index] ?? "hang";
    this.index++;
    return new Promise((resolve, reject) => {
      if (behavior === "reject-409") {
        queueMicrotask(() => reject(Object.assign(new Error("Conflict"), { error_code: 409 })));
        return;
      }
      if (behavior === "reject-other") {
        queueMicrotask(() => reject(new Error("ETIMEDOUT")));
        return;
      }
      if (behavior === "run") {
        options?.onStart?.({ username: "mockbot" });
      }
      // "run" dan "hang" sama-sama menggantung (meniru long-poll aktif) sampai stop() memanggil resolve.
      this.pendingResolve = resolve;
    });
  }

  stop(): Promise<void> {
    this.stopCalls++;
    this.pendingResolve?.();
    this.pendingResolve = null;
    return Promise.resolve();
  }

  /** Simulasikan grammy memanggil error handler di tengah pemrosesan satu update. */
  triggerCatch(err: unknown): void {
    this.catch?.(err);
  }
}

function silenceStderr() {
  return spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("createPoller — LOSS-6: 409 Conflict beruntun", () => {
  test("8x 409 Conflict -> dead + stop(), tidak retry ke-9", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot(Array(8).fill("reject-409"));
    const statuses: PollerStatus[] = [];
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      onStatus: (s) => statuses.push(s),
      retryDelayMs: () => 0,
    });

    await poller.start();

    expect(bot.startCalls).toBe(8);
    expect(bot.stopCalls).toBe(1);
    expect(statuses.at(-1)).toEqual({ state: "dead", reason: "conflict-409" });
    stderrSpy.mockRestore();
  });

  test("< 8x 409 lalu sukses -> reset, tidak pernah dead", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot([
      "reject-409",
      "reject-409",
      "reject-409",
      "run", // sukses sebelum ambang 8 tercapai -> reset attempt/conflictStreak
    ]);
    const statuses: PollerStatus[] = [];
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      onStatus: (s) => statuses.push(s),
      retryDelayMs: () => 0,
    });

    poller.start();
    await Promise.resolve(); // biarkan microtask reject 3x + resolve start ke-4 jalan
    await new Promise((r) => setImmediate(r));

    expect(statuses.some((s) => s.state === "dead")).toBe(false);
    expect(statuses.some((s) => s.state === "running")).toBe(true);

    await poller.stop();
    expect(bot.stopCalls).toBe(1);
    stderrSpy.mockRestore();
  });
});

describe("createPoller — SCAR-061: bot.catch tidak mematikan polling", () => {
  test("error di tengah proses update -> onStatus degraded, TANPA stop()", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot(["run"]);
    const statuses: PollerStatus[] = [];
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      onStatus: (s) => statuses.push(s),
      retryDelayMs: () => 0,
    });

    poller.start();
    await Promise.resolve();
    expect(statuses.some((s) => s.state === "running")).toBe(true);

    bot.triggerCatch(new Error("middleware meledak"));

    expect(statuses.at(-1)).toEqual({ state: "degraded", reason: "middleware meledak" });
    // Poin inti SCAR-061: bot.stop() TIDAK dipanggil oleh error handler.
    expect(bot.stopCalls).toBe(0);

    await poller.stop();
    expect(bot.stopCalls).toBe(1);
    stderrSpy.mockRestore();
  });
});

describe("createPoller — stop() idempoten", () => {
  test("stop() berkali-kali hanya memanggil bot.stop() sekali, tidak throw", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot(["run"]);
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      retryDelayMs: () => 0,
    });

    poller.start();
    await Promise.resolve();

    await poller.stop();
    await poller.stop();
    await poller.stop();

    expect(bot.stopCalls).toBe(1);
    stderrSpy.mockRestore();
  });

  test("stop() sebelum start() dipanggil tidak throw dan tidak memulai polling", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot(["run"]);
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      retryDelayMs: () => 0,
    });

    await expect(poller.stop()).resolves.toBeUndefined();
    expect(bot.startCalls).toBe(0);
    stderrSpy.mockRestore();
  });
});

describe("createPoller — onInbound", () => {
  test("dipasang lewat bot.use saat disediakan", async () => {
    const stderrSpy = silenceStderr();
    const bot = new MockBot(["run"]);
    const useSpy = spyOn(bot, "use");
    let inboundCalled = false;
    const poller = createPoller({
      token: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      botFactory: () => bot,
      onInbound: () => {
        inboundCalled = true;
      },
      retryDelayMs: () => 0,
    });
    expect(useSpy).toHaveBeenCalledTimes(1);
    void inboundCalled; // middleware sesungguhnya dijalankan oleh grammy, di luar cakupan mock ini
    await poller.stop();
    stderrSpy.mockRestore();
  });
});
