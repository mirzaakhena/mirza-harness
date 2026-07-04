import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import type { Context } from "grammy";
import type { CreatePollerOptions, Poller } from "@mirza-harness/telegram-adapter";
import { defaultAccess } from "@mirza-harness/shared";
import { startHostd, type HostdHandle } from "../src/main";
import { setAccess } from "../src/state/access-store";
import { claimNext } from "../src/bus/bus";
import type { HostdConfig } from "../src/config";

/**
 * Task D2, Fase 1 — smoke test for the production assembly (`startHostd`).
 * Exercises the FULL wiring — pipe server, rpc-handlers (doctor/agent.list),
 * delivery, and the real `createInboundPipeline` reached through
 * `startTelegramAdapters`'s `onInbound` — with NO real network:
 *  - `createPoller` is a fake (never calls grammy/Telegram; per Task C3
 *    convention, injectable specifically so tests never start real polling).
 *  - `dbPath: ":memory:"` — no file I/O.
 *  - The one bot's `telegram_token` never gets used for a real HTTP call in
 *    these tests: the "onInbound reaches the bus" test pre-allowlists the
 *    sender so `gate()` returns 'deliver' (bus enqueue), not 'pairing-reply'
 *    (which would fire a real `Api.sendMessage` in the background).
 */

const VALID_TOKEN = "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function rpcCall(pipe: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe, () => sock.write(JSON.stringify(payload) + "\n"));
    let buf = "";
    sock.on("data", d => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
}

function makeFakeConfig(): HostdConfig {
  return { bots: [{ id: "bot-smoke", telegram_token: VALID_TOKEN, workspace: "C:/ws/bot-smoke" }] };
}

function fakeCreatePoller(captured: { onInbound?: (ctx: Context) => void | Promise<void> }) {
  return (options: CreatePollerOptions): Poller => {
    captured.onInbound = options.onInbound;
    options.onStatus?.({ state: "running", username: "smokebot" });
    return {
      start: () => new Promise<void>(() => {}), // never resolves — mirrors a poller that just keeps running
      stop: async () => {},
    };
  };
}

describe("startHostd — smoke", () => {
  let handle: HostdHandle | undefined;
  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
  });

  test("wires server + delivery + adapters + rpc-handlers without real polling; doctor/agent.list reachable over the pipe", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-smoke-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      createPoller: fakeCreatePoller(captured),
    });

    expect(handle.adapters.pollers.size).toBe(1);
    expect(captured.onInbound).toBeDefined(); // startTelegramAdapters really called our fake factory

    const doctorRes = await rpcCall(pipe, { jsonrpc: "2.0", id: 1, method: "doctor" });
    expect(doctorRes.result.ok).toBe(true);
    expect(JSON.parse(doctorRes.result.components.adapters)).toEqual({ "bot-smoke": "running" });

    const listRes = await rpcCall(pipe, { jsonrpc: "2.0", id: 2, method: "agent.list" });
    expect(listRes.result).toEqual([{ name: "bot-smoke", workspace: "C:/ws/bot-smoke", poller_status: "running", stub_connected: false }]);

    const statusRes = await rpcCall(pipe, { jsonrpc: "2.0", id: 3, method: "agent.status", params: { name: "bot-smoke" } });
    expect(statusRes.result).toEqual({
      name: "bot-smoke",
      workspace: "C:/ws/bot-smoke",
      poller_status: "running",
      stub_connected: false,
      session: null,
    });
  });

  test("onInbound wiring reaches the real inbound pipeline: an allowlisted sender's text ends up enqueued on the bus", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-inbound-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      createPoller: fakeCreatePoller(captured),
    });

    // Pre-allowlist the sender so gate() returns 'deliver' (bus enqueue) —
    // NOT 'pairing-reply' (which would fire a real Api.sendMessage).
    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      message: { message_id: 1, text: "halo dari smoke test", date: Math.floor(Date.now() / 1000) },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    const env = claimNext(handle.db, "bot-smoke");
    expect(env).not.toBeNull();
    expect(env!.kind).toBe("channel-inbound");
    expect((env!.payload as { content: string }).content).toBe("halo dari smoke test");
  });

  test("shutdown() is idempotent and actually stops the poller + closes the pipe", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-shutdown-${process.pid}`;
    let stopCalls = 0;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      createPoller: (options: CreatePollerOptions): Poller => {
        captured.onInbound = options.onInbound;
        return {
          start: () => new Promise<void>(() => {}),
          stop: async () => {
            stopCalls++;
          },
        };
      },
    });

    await handle.shutdown();
    await handle.shutdown(); // second call must be a no-op, not throw
    expect(stopCalls).toBe(1);

    await expect(rpcCall(pipe, { jsonrpc: "2.0", id: 1, method: "doctor" })).rejects.toBeDefined();
    handle = undefined; // already shut down — afterEach shouldn't shut down again
  });

  test("shutdown() resolves quickly even with a still-connected, registered cc-stub client (Bug 2)", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-shutdown-stub-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      createPoller: fakeCreatePoller(captured),
    });

    // Connect a client and perform the real "register" handshake a cc-stub
    // does (session.register — see packages/hostd/test/server.test.ts and
    // packages/hostd/src/server.ts), then deliberately NEVER call `.end()`
    // — this is the still-connected client that used to hang server.close()
    // forever (Bug 2).
    const sock = net.connect(pipe);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    let closeReceived = false;
    sock.once("close", () => {
      closeReceived = true;
    });

    const registerResult = await new Promise<any>((resolve, reject) => {
      let buf = "";
      sock.on("data", d => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
      });
      sock.once("error", reject);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.register", params: { bot_id: "bot-smoke" } }) + "\n");
      setTimeout(() => reject(new Error("timeout menunggu balasan session.register")), 5000);
    });
    expect(registerResult.result).toEqual({ registered: true, bot_id: "bot-smoke" });

    const start = Date.now();
    await Promise.race([
      handle.shutdown(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown() did not resolve within the test's own 3s guard")), 3000)),
    ]);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(3000);

    // The client-side socket must also have been torn down (destroyed by
    // hostd), not left dangling.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(closeReceived).toBe(true);

    handle = undefined; // already shut down — afterEach shouldn't shut down again
  });
});
