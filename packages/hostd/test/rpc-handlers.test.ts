import { describe, expect, test } from "bun:test";
import { openDb } from "../src/state/db";
import { claimNext } from "../src/bus/bus";
import { parseAgentPrompt } from "../src/bus/marker";
import {
  handleTelegramOutbound,
  handleAgentList,
  handleAgentStatus,
  handleAgentSend,
  type RpcHandlerDeps,
} from "../src/rpc-handlers";
import type { OutboundSender } from "@mirza-harness/telegram-adapter";
import type { HostdConfig } from "../src/config";

function makeConfig(overrides: Partial<HostdConfig> = {}): HostdConfig {
  return {
    bots: [
      { id: "bot-01", telegram_token: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspace: "C:/workspace/bot-01" },
      { id: "bot-02", telegram_token: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", workspace: "C:/workspace/bot-02" },
    ],
    ...overrides,
  };
}

function baseDeps(overrides: Partial<RpcHandlerDeps> = {}): RpcHandlerDeps {
  return {
    db: openDb(":memory:"),
    config: makeConfig(),
    telegramSenders: new Map(),
    adapterStatuses: new Map(),
    isRegistered: () => false,
    ...overrides,
  };
}

describe("handleTelegramOutbound", () => {
  test("proxies to the bot_id's registered sender.handle(cmd)", async () => {
    const calls: unknown[] = [];
    const sender: OutboundSender = { handle: async cmd => { calls.push(cmd); return "sent (id: 1)"; } };
    const deps = baseDeps({ telegramSenders: new Map([["bot-01", sender]]) });

    const result = await handleTelegramOutbound({ bot_id: "bot-01", cmd: { op: "reply", chat_id: "1", text: "hi" } }, deps);

    expect(result).toBe("sent (id: 1)");
    expect(calls).toEqual([{ op: "reply", chat_id: "1", text: "hi" }]);
  });

  test("unknown bot_id -> clear error, sender never called", async () => {
    const deps = baseDeps();
    await expect(handleTelegramOutbound({ bot_id: "bot-99", cmd: { op: "reply", chat_id: "1", text: "hi" } }, deps)).rejects.toThrow(
      /bot-99/,
    );
  });

  test("bad params shape (missing cmd) -> zod error, not silently accepted", async () => {
    const deps = baseDeps();
    await expect(handleTelegramOutbound({ bot_id: "bot-01" }, deps)).rejects.toThrow();
  });
});

describe("handleAgentList", () => {
  test("lists every bot from config with poller status + stub connection", () => {
    const deps = baseDeps({
      adapterStatuses: new Map([["bot-01", { state: "running", username: "bot1" }]]),
      isRegistered: (id: string) => id === "bot-01",
    });

    const result = handleAgentList(undefined, deps);

    expect(result).toEqual([
      { name: "bot-01", workspace: "C:/workspace/bot-01", poller_status: "running", stub_connected: true },
      { name: "bot-02", workspace: "C:/workspace/bot-02", poller_status: "unknown", stub_connected: false },
    ]);
  });
});

describe("handleAgentStatus", () => {
  test("known bot, no sessions row yet -> session: null (honest, not faked)", () => {
    const deps = baseDeps({ adapterStatuses: new Map([["bot-01", { state: "running" }]]), isRegistered: () => true });
    const result = handleAgentStatus({ name: "bot-01" }, deps);
    expect(result).toEqual({
      name: "bot-01",
      workspace: "C:/workspace/bot-01",
      poller_status: "running",
      stub_connected: true,
      session: null,
    });
  });

  test("once a sessions row exists (fase 2 stand-in), it is returned — not hardcoded", () => {
    const deps = baseDeps();
    deps.db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?)`, ["bot-01", "C:/workspace/bot-01"]);
    deps.db.run(`INSERT INTO sessions (id, bot_id, name, lifecycle, started_at) VALUES (?, ?, ?, ?, ?)`, [
      "sess-1",
      "bot-01",
      "my-session",
      "idle",
      1000,
    ]);
    const result = handleAgentStatus({ name: "bot-01" }, deps);
    expect(result.session).toEqual({ id: "sess-1", name: "my-session", lifecycle: "idle", started_at: 1000, ended_at: null });
  });

  test("unknown bot name -> clear error listing known bots", () => {
    const deps = baseDeps();
    expect(() => handleAgentStatus({ name: "bot-99" }, deps)).toThrow(/bot-01, bot-02/);
  });
});

describe("handleAgentSend", () => {
  test("known target -> enqueues a 'prompt' envelope with the composed marker; queued:true", () => {
    const deps = baseDeps();
    const result = handleAgentSend({ from: "bot-01", target: "bot-02", payload: { kind: "prompt", body: "halo" } }, deps);

    expect(result).toEqual([{ target: "bot-02", queued: true }]);

    const env = claimNext(deps.db, "bot-02");
    expect(env).not.toBeNull();
    expect(env!.from).toBe("bot-01");
    expect(env!.kind).toBe("prompt");
    const payload = env!.payload as { content: string; meta: Record<string, string> };
    const parsed = parseAgentPrompt(payload.content);
    expect(parsed?.from).toBe("bot-01");
    expect(parsed?.hop).toBe(0);
    expect(parsed?.body).toBe("halo");
    expect(payload.meta).toEqual({ from: "bot-01", hop: "0", kind: "agent-prompt" });
  });

  test("broadcast to multiple targets -> one envelope enqueued per target, per-target result", () => {
    const deps = baseDeps();
    const result = handleAgentSend(
      { from: "bot-01", target: ["bot-01", "bot-02"], payload: { kind: "prompt", body: "broadcast" } },
      deps,
    );
    expect(result).toEqual([
      { target: "bot-01", queued: true },
      { target: "bot-02", queued: true },
    ]);
    expect(claimNext(deps.db, "bot-01")).not.toBeNull();
    expect(claimNext(deps.db, "bot-02")).not.toBeNull();
  });

  test("target not in hostd config -> queued:false with a reason, NOT enqueued (honest per-target result, SCAR-071)", () => {
    const deps = baseDeps();
    const result = handleAgentSend({ from: "bot-01", target: "ghost-bot", payload: { kind: "prompt", body: "hi" } }, deps);

    expect(result).toEqual([{ target: "ghost-bot", queued: false, reason: expect.stringContaining("ghost-bot") }]);
    expect(claimNext(deps.db, "ghost-bot")).toBeNull();
  });

  test("hop_count carried through into the composed marker and envelope.hop", () => {
    const deps = baseDeps();
    handleAgentSend({ from: "bot-01", target: "bot-02", payload: { kind: "prompt", body: "hi", hop_count: 2 } }, deps);
    const env = claimNext(deps.db, "bot-02");
    expect(env!.hop).toBe(2);
  });

  test("missing `from` defaults to 'unknown' rather than throwing", () => {
    const deps = baseDeps();
    const result = handleAgentSend({ target: "bot-02", payload: { kind: "prompt", body: "hi" } }, deps);
    expect(result).toEqual([{ target: "bot-02", queued: true }]);
    const env = claimNext(deps.db, "bot-02");
    expect(env!.from).toBe("unknown");
  });

  test("body over 8KB -> zod rejects upfront, nothing enqueued", () => {
    const deps = baseDeps();
    const big = "x".repeat(8 * 1024 + 1);
    expect(() => handleAgentSend({ from: "bot-01", target: "bot-02", payload: { kind: "prompt", body: big } }, deps)).toThrow();
    expect(claimNext(deps.db, "bot-02")).toBeNull();
  });

  test("hop_count over MAX_HOP -> zod rejects upfront", () => {
    const deps = baseDeps();
    expect(() =>
      handleAgentSend({ from: "bot-01", target: "bot-02", payload: { kind: "prompt", body: "hi", hop_count: 6 } }, deps),
    ).toThrow();
  });
});
