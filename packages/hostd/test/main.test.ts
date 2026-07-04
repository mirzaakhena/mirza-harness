import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import type { Api, Context } from "grammy";
import type { CreatePollerOptions, Poller } from "@mirza-harness/telegram-adapter";
import { defaultAccess } from "@mirza-harness/shared";
import { startHostd, type HostdHandle } from "../src/main";
import { setAccess } from "../src/state/access-store";
import { claimNext } from "../src/bus/bus";
import type { HostdConfig } from "../src/config";
import type { HolderHandle, SpawnHolderFn } from "../src/supervisor/supervisor";
import type { SessionOps } from "../src/supervisor/session-ops";

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

/**
 * Task S1, Fase 2 — these smoke tests exercise the D2/C4 wiring, not the
 * supervisor; `startHostd` now always spawns a `BotSupervisor` per bot, so a
 * fake `spawnHolder` (never a real `node --import tsx pty-holder` child) is
 * REQUIRED here per the S1 brief's "test JANGAN spawn holder Node
 * sungguhan". `enableLegacyPendingShim: false` keeps these tests from also
 * standing up a real fs.watch/sweep loop against `state/bot-smoke/pending`
 * — that shim gets its own coverage in pending-consumer.test.ts.
 */
const fakeSpawnHolder: SpawnHolderFn = (): HolderHandle => ({
  inject() {},
  injectSlash() {},
  shutdown: () => Promise.resolve(),
  forceKill() {},
  on() {},
});
const SUPERVISOR_TEST_OPTS = { spawnHolder: fakeSpawnHolder, enableLegacyPendingShim: false } as const;

/**
 * Task E1' assembly tests — a fake grammy `Api` (records every `sendMessage`/
 * `editMessageText` call instead of a real HTTPS call). Overriding
 * `createApi` this way means these tests exercise the REAL meta-command
 * (M1) and /context+/version (M2) send paths end-to-end without any network
 * access, unlike the existing tests above which carefully avoid ever
 * reaching `Api.sendMessage` at all.
 */
interface FakeApiCall {
  kind: "sendMessage" | "editMessageText";
  chatId: string;
  text: string;
  other?: unknown;
}
function fakeApi(calls: FakeApiCall[]): Api {
  return {
    sendMessage: async (chat_id: string, text: string, other?: unknown) => {
      calls.push({ kind: "sendMessage", chatId: String(chat_id), text, other });
      return { message_id: 1 };
    },
    editMessageText: async (chat_id: string, _message_id: number, text: string, other?: unknown) => {
      calls.push({ kind: "editMessageText", chatId: String(chat_id), text, other });
      return true;
    },
  } as unknown as Api;
}

/**
 * Fake `SessionOps` (session-ops.ts) — every method is a spy-friendly stub.
 * Required for any test exercising `/new /switch /delete /rename /effort`:
 * the real `createSessionOps` awaits a genuine injection ack via
 * `supervisor.queue` (up to `clearAckTimeoutMs`, ~135s default), which
 * `fakeSpawnHolder` (never a real pty-holder — see `SUPERVISOR_TEST_OPTS`'s
 * doc) never fires, so a test using the real implementation would hang.
 */
function fakeSessionOps(overrides: Partial<SessionOps> = {}): SessionOps {
  return {
    listSessions: () => [],
    currentSession: () => null,
    isAlive: () => true,
    resume: () => ({ ok: true }),
    rename: async () => ({ ok: true, from: "idle", to: "renamed" }),
    clearSession: async () => ({ ok: true, nameApplied: true }),
    setEffort: () => ({ ok: true }),
    archiveSession: () => ({ ok: true }),
    hardDelete: () => ({ ok: true }),
    bulkArchive: () => ({ processed: 0, skipped: 0, errors: 0 }),
    bulkDelete: () => ({ processed: 0, skipped: 0, errors: 0 }),
    ...overrides,
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
      ...SUPERVISOR_TEST_OPTS,
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
      ...SUPERVISOR_TEST_OPTS,
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

  test("E1-1: an authorized ai:* callback tap is acked without a text (clears the Telegram spinner)", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-cb-ok-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const answerCalls: unknown[] = [];
    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      callbackQuery: {
        data: "ai:yes",
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), reply_markup: { inline_keyboard: [] } },
      },
      answerCallbackQuery: async (arg?: unknown) => {
        answerCalls.push(arg);
      },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    expect(answerCalls).toEqual([undefined]);

    const env = claimNext(handle.db, "bot-smoke");
    expect(env).not.toBeNull();
  });

  test("E1-1: an unauthorized ai:* callback tap is acked with 'Not authorized.'", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-cb-unauth-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
    });

    // Sender NOT in allowFrom + dmPolicy 'allowlist' (default) -> gate() drops.
    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: [], dmPolicy: "allowlist" }, "telegram");

    const answerCalls: unknown[] = [];
    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "stranger" },
      callbackQuery: {
        data: "ai:yes",
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), reply_markup: { inline_keyboard: [] } },
      },
      answerCallbackQuery: async (arg?: unknown) => {
        answerCalls.push(arg);
      },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    expect(answerCalls).toEqual([{ text: "Not authorized." }]);
  });

  test("E1-1: answerCallbackQuery throwing (expired callback query) never crashes the pipeline", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-cb-expired-${process.pid}`;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      callbackQuery: {
        data: "ai:yes",
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), reply_markup: { inline_keyboard: [] } },
      },
      answerCallbackQuery: async () => {
        throw new Error("400: query is too old and response timeout expired");
      },
    } as unknown as Context;

    // Must resolve, not reject/throw.
    await expect(captured.onInbound!(fakeCtx)).resolves.toBeUndefined();

    const env = claimNext(handle.db, "bot-smoke");
    expect(env).not.toBeNull();
  });

  test("shutdown() is idempotent and actually stops the poller + closes the pipe", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-shutdown-${process.pid}`;
    let stopCalls = 0;

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
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
      ...SUPERVISOR_TEST_OPTS,
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

/**
 * Task E1' (Fase 2 assembly) — proves the wiring main.ts adds on top of the
 * D2/C4/S1 smoke tests above: metaCommands (M1) reaches session-ops (S2),
 * /context (M2) is answered directly after SEC-1's gate, and the ackCallback
 * fix (E1-1 regression) labels a successful meta: tap correctly. Uses the
 * same `fakeSpawnHolder`/`fakeCreatePoller` conventions as the smoke suite
 * above, plus `createApi`/`sessionOps` (both test-only seams added in this
 * task) so NEITHER a real Telegram HTTP call NOR session-ops's real
 * injection-ack polling ever runs in this suite.
 */
describe("startHostd — Task E1' assembly (meta-commands, /context, ackCallback fix)", () => {
  let handle: HostdHandle | undefined;
  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
  });

  test("Task M1: an allowlisted sender's '/new foo' reaches SessionOps.clearSession via the metaCommands adaptor, and its meta-executed reply is sent (not delivered to the AI)", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-meta-new-${process.pid}`;

    const clearSessionCalls: Array<{ bot: unknown; opts: unknown }> = [];
    const sessionOps = fakeSessionOps({
      clearSession: async (bot, opts) => {
        clearSessionCalls.push({ bot, opts });
        return { ok: true, nameApplied: true };
      },
    });
    const apiCalls: FakeApiCall[] = [];

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
      createApi: () => fakeApi(apiCalls),
      sessionOps,
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      message: { message_id: 1, text: "/new foo", date: Math.floor(Date.now() / 1000) },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    // The metaCommands adaptor (session-ops-client.ts) called SessionOps.clearSession —
    // NOT the bus (no envelope should have been enqueued for the AI).
    expect(clearSessionCalls).toEqual([{ bot: { id: "bot-smoke", workspace: "C:/ws/bot-smoke" }, opts: { name: "foo" } }]);
    expect(claimNext(handle.db, "bot-smoke")).toBeNull();

    // The meta-executed result was sent as a brand-new message via the raw Api
    // (not OutboundSender's ai:*-prefixed buttons path — this message has no buttons anyway).
    expect(apiCalls).toEqual([{ kind: "sendMessage", chatId: "999", text: '🧹 New session started as "foo".', other: undefined }]);
  });

  test("Task M2: an allowlisted sender's '/context' is answered directly after SEC-1's gate, never delivered to the AI", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-context-${process.pid}`;
    const apiCalls: FakeApiCall[] = [];

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
      createApi: () => fakeApi(apiCalls),
      sessionOps: fakeSessionOps(),
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      message: { message_id: 1, text: "/context", date: Math.floor(Date.now() / 1000) },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    // buildContextReply(botId, sessionQuery) ran (SessionQuery read the real,
    // empty `sessions` table for bot-smoke) and rendered the "no data yet"
    // fallback (context-command.ts's renderContextReply(null)) — proof it was
    // actually invoked, past SEC-1's gate, rather than silently dropped.
    expect(apiCalls).toEqual([{ kind: "sendMessage", chatId: "999", text: "(no data yet)", other: {} }]);
    // Never delivered to the AI as a plain message.
    expect(claimNext(handle.db, "bot-smoke")).toBeNull();
  });

  test("Task M2 + SEC-1: a NON-allowlisted sender's '/context' is dropped by gate() — never answered, never delivered", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-context-drop-${process.pid}`;
    const apiCalls: FakeApiCall[] = [];

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
      createApi: () => fakeApi(apiCalls),
      sessionOps: fakeSessionOps(),
    });

    // NOT allowlisted + dmPolicy 'allowlist' (default) -> gate() drops (SEC-1: no leniency for info commands).
    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: [], dmPolicy: "allowlist" }, "telegram");

    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "stranger" },
      message: { message_id: 1, text: "/context", date: Math.floor(Date.now() / 1000) },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    expect(apiCalls).toEqual([]);
    expect(claimNext(handle.db, "bot-smoke")).toBeNull();
  });

  test("E1' fix: an authorized meta: callback tap (e.g. 'meta:cancel') acks with its OWN text, never the generic 'Not authorized.'", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-meta-cb-${process.pid}`;
    const apiCalls: FakeApiCall[] = [];

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
      createApi: () => fakeApi(apiCalls),
      sessionOps: fakeSessionOps(),
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: ["999"] }, "telegram");

    const answerCalls: unknown[] = [];
    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "tester" },
      callbackQuery: {
        data: "meta:cancel",
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), reply_markup: { inline_keyboard: [] } },
      },
      answerCallbackQuery: async (arg?: unknown) => {
        answerCalls.push(arg);
      },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    // meta-commands.ts's "cancel" branch: [{kind:'ack',text:'Cancelled'}, {kind:'edit',...}].
    expect(answerCalls).toEqual([{ text: "Cancelled" }]);
    expect(answerCalls).not.toContainEqual({ text: "Not authorized." });
  });

  test("E1' fix: an UNAUTHORIZED ai:* callback tap is still acked with 'Not authorized.' (dropped outcome unchanged)", async () => {
    const captured: { onInbound?: (ctx: Context) => void | Promise<void> } = {};
    const pipe = `\\\\.\\pipe\\mirza-hostd-test-main-cb-unauth-e1prime-${process.pid}`;
    const apiCalls: FakeApiCall[] = [];

    handle = await startHostd({
      config: makeFakeConfig(),
      dbPath: ":memory:",
      pipeName: pipe,
      ...SUPERVISOR_TEST_OPTS,
      createPoller: fakeCreatePoller(captured),
      createApi: () => fakeApi(apiCalls),
      sessionOps: fakeSessionOps(),
    });

    setAccess(handle.db, "bot-smoke", { ...defaultAccess(), allowFrom: [], dmPolicy: "allowlist" }, "telegram");

    const answerCalls: unknown[] = [];
    const fakeCtx = {
      chat: { id: 999, type: "private" },
      from: { id: 999, username: "stranger" },
      callbackQuery: {
        data: "ai:yes",
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), reply_markup: { inline_keyboard: [] } },
      },
      answerCallbackQuery: async (arg?: unknown) => {
        answerCalls.push(arg);
      },
    } as unknown as Context;

    await captured.onInbound!(fakeCtx);

    expect(answerCalls).toEqual([{ text: "Not authorized." }]);
  });
});
