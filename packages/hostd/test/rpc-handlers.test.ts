import { describe, expect, test } from "bun:test";
import { openDb } from "../src/state/db";
import { claimNext } from "../src/bus/bus";
import { parseAgentPrompt } from "../src/bus/marker";
import {
  handleTelegramOutbound,
  handleAgentList,
  handleAgentStatus,
  handleAgentSend,
  handleSessionStarted,
  handleTelemetryReport,
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
    expect(result.session).toEqual({
      id: "sess-1",
      name: "my-session",
      lifecycle: "idle",
      started_at: 1000,
      ended_at: null,
      used_percentage: null,
      context_window_size: null,
      model: null,
      effort: null,
      cost: null,
      captured_at_ms: null,
    });
  });

  test("telemetry columns populated by telemetry.report are surfaced (INFRA-5: same row agent.status reads)", () => {
    const deps = baseDeps();
    deps.db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?)`, ["bot-01", "C:/workspace/bot-01"]);
    deps.db.run(`INSERT INTO sessions (id, bot_id, name, lifecycle, started_at) VALUES (?, ?, ?, ?, ?)`, [
      "sess-1",
      "bot-01",
      "my-session",
      "idle",
      1000,
    ]);
    handleTelemetryReport(
      {
        bot_id: "bot-01",
        session_id: "sess-1",
        used_percentage: 42.5,
        context_window_size: 200000,
        model: "claude-sonnet-5",
        effort: "high",
        cost: 1.23,
        captured_at_ms: 1720000000000,
      },
      deps,
    );

    const result = handleAgentStatus({ name: "bot-01" }, deps);
    expect(result.session).toEqual({
      id: "sess-1",
      name: "my-session",
      lifecycle: "idle",
      started_at: 1000,
      ended_at: null,
      used_percentage: 42.5,
      context_window_size: 200000,
      model: "claude-sonnet-5",
      effort: "high",
      cost: 1.23,
      captured_at_ms: 1720000000000,
    });
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

describe("handleSessionStarted", () => {
  test("brand-new session_id -> row inserted, lifecycle+name default 'idle', additionalContext reflects it", () => {
    const deps = baseDeps({ now: () => 5000 });

    const result = handleSessionStarted({ bot_id: "bot-01", session_id: "sess-new", source: "startup", cwd: "C:/workspace/bot-01" }, deps);

    expect(result).toEqual({ additionalContext: 'Current session name: "idle"' });
    const row = deps.db.query(`SELECT id, bot_id, name, lifecycle, started_at FROM sessions WHERE id = ?`).get("sess-new");
    expect(row).toEqual({ id: "sess-new", bot_id: "bot-01", name: "idle", lifecycle: "idle", started_at: 5 });
  });

  test("resolves the bot via cwd->workspace mapping, not the hook's self-reported bot_id", () => {
    const deps = baseDeps();
    // bot_id claimed is bot-02, but cwd matches bot-01's workspace — workspace mapping wins.
    const result = handleSessionStarted({ bot_id: "bot-02", session_id: "sess-x", source: "startup", cwd: "C:/workspace/bot-01" }, deps);
    expect(result).toEqual({ additionalContext: 'Current session name: "idle"' });
    const row = deps.db.query(`SELECT bot_id FROM sessions WHERE id = ?`).get("sess-x") as { bot_id: string };
    expect(row.bot_id).toBe("bot-01");
  });

  test("cwd doesn't match any workspace -> falls back to bot_id match", () => {
    const deps = baseDeps();
    const result = handleSessionStarted({ bot_id: "bot-02", session_id: "sess-y", source: "startup", cwd: "C:/somewhere/else" }, deps);
    expect(result).toEqual({ additionalContext: 'Current session name: "idle"' });
    const row = deps.db.query(`SELECT bot_id FROM sessions WHERE id = ?`).get("sess-y") as { bot_id: string };
    expect(row.bot_id).toBe("bot-02");
  });

  test("neither cwd nor bot_id resolve to a known bot -> clear error, nothing written", () => {
    const deps = baseDeps();
    expect(() =>
      handleSessionStarted({ bot_id: "ghost-bot", session_id: "sess-z", source: "startup", cwd: "C:/nowhere" }, deps),
    ).toThrow(/tidak cocok workspace bot manapun/);
    expect(deps.db.query(`SELECT * FROM sessions WHERE id = ?`).get("sess-z")).toBeNull();
  });

  test("no `bots` row pre-populated (production reality today) -> FK satisfied by handler's own upsert, not a crash", () => {
    const deps = baseDeps();
    expect(deps.db.query(`SELECT * FROM bots WHERE id = ?`).get("bot-01")).toBeNull();
    expect(() =>
      handleSessionStarted({ bot_id: "bot-01", session_id: "sess-fk", source: "startup", cwd: "C:/workspace/bot-01" }, deps),
    ).not.toThrow();
    expect(deps.db.query(`SELECT * FROM bots WHERE id = ?`).get("bot-01")).not.toBeNull();
  });

  test("existing session_id previously marked 'resetting' with a custom name -> lifecycle flips to 'idle', name/started_at preserved (fix M4)", () => {
    const deps = baseDeps();
    deps.db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?)`, ["bot-01", "C:/workspace/bot-01"]);
    deps.db.run(`INSERT INTO sessions (id, bot_id, name, lifecycle, started_at) VALUES (?, ?, ?, ?, ?)`, [
      "sess-resume",
      "bot-01",
      "my-renamed-session",
      "resetting",
      1000,
    ]);

    const result = handleSessionStarted({ bot_id: "bot-01", session_id: "sess-resume", source: "clear", cwd: "C:/workspace/bot-01" }, deps);

    expect(result).toEqual({ additionalContext: 'Current session name: "my-renamed-session"' });
    const row = deps.db.query(`SELECT name, lifecycle, started_at FROM sessions WHERE id = ?`).get("sess-resume");
    expect(row).toEqual({ name: "my-renamed-session", lifecycle: "idle", started_at: 1000 });
  });

  test("releases the resolved bot's supervisor barrier via onSessionStarted() (fake supervisor)", () => {
    let released = 0;
    const supervisors = new Map([["bot-01", { onSessionStarted: () => { released += 1; } }]]);
    const deps = baseDeps({ supervisors });

    handleSessionStarted({ bot_id: "bot-01", session_id: "sess-barrier", source: "startup", cwd: "C:/workspace/bot-01" }, deps);

    expect(released).toBe(1);
  });

  test("only the resolved bot's supervisor is released, not another bot's", () => {
    const released: string[] = [];
    const supervisors = new Map([
      ["bot-01", { onSessionStarted: () => released.push("bot-01") }],
      ["bot-02", { onSessionStarted: () => released.push("bot-02") }],
    ]);
    const deps = baseDeps({ supervisors });

    handleSessionStarted({ bot_id: "bot-02", session_id: "sess-barrier-2", source: "startup", cwd: "C:/workspace/bot-02" }, deps);

    expect(released).toEqual(["bot-02"]);
  });

  test("no `supervisors` dep wired -> barrier release silently no-ops (row still written, reply still returned)", () => {
    const deps = baseDeps();
    expect(() =>
      handleSessionStarted({ bot_id: "bot-01", session_id: "sess-no-supervisor", source: "startup", cwd: "C:/workspace/bot-01" }, deps),
    ).not.toThrow();
    expect(deps.db.query(`SELECT * FROM sessions WHERE id = ?`).get("sess-no-supervisor")).not.toBeNull();
  });

  test("bad params shape (missing session_id) -> zod error, nothing written", () => {
    const deps = baseDeps();
    expect(() => handleSessionStarted({ bot_id: "bot-01", source: "startup", cwd: "C:/workspace/bot-01" }, deps)).toThrow();
  });
});

describe("handleTelemetryReport", () => {
  function seedSession(deps: RpcHandlerDeps, botId: string, sessionId: string): void {
    deps.db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?)`, [botId, `C:/workspace/${botId}`]);
    deps.db.run(`INSERT INTO sessions (id, bot_id, name, lifecycle, started_at) VALUES (?, ?, 'idle', 'idle', ?)`, [
      sessionId,
      botId,
      1000,
    ]);
  }

  test("existing session row -> telemetry columns updated, updated:true", () => {
    const deps = baseDeps();
    seedSession(deps, "bot-01", "sess-1");

    const result = handleTelemetryReport(
      {
        bot_id: "bot-01",
        session_id: "sess-1",
        used_percentage: 55,
        context_window_size: 180000,
        model: "claude-opus",
        effort: "medium",
        cost: 0.42,
        captured_at_ms: 1700000000000,
      },
      deps,
    );

    expect(result).toEqual({ updated: true });
    const row = deps.db
      .query(`SELECT used_percentage, context_window_size, model, effort, cost, captured_at_ms FROM sessions WHERE id = ?`)
      .get("sess-1");
    expect(row).toEqual({
      used_percentage: 55,
      context_window_size: 180000,
      model: "claude-opus",
      effort: "medium",
      cost: 0.42,
      captured_at_ms: 1700000000000,
    });
  });

  test("fields omitted/null -> written as NULL, not 0/empty-string (FUNC-1 nullable contract)", () => {
    const deps = baseDeps();
    seedSession(deps, "bot-01", "sess-1");

    const result = handleTelemetryReport({ bot_id: "bot-01", session_id: "sess-1" }, deps);

    expect(result).toEqual({ updated: true });
    const row = deps.db
      .query(`SELECT used_percentage, context_window_size, model, effort, cost, captured_at_ms FROM sessions WHERE id = ?`)
      .get("sess-1");
    expect(row).toEqual({
      used_percentage: null,
      context_window_size: null,
      model: null,
      effort: null,
      cost: null,
      captured_at_ms: null,
    });
  });

  test("no matching (bot_id, session_id) row -> updated:false, does not throw (honest no-op, not faked success)", () => {
    const deps = baseDeps();
    const result = handleTelemetryReport({ bot_id: "bot-01", session_id: "sess-does-not-exist" }, deps);
    expect(result).toEqual({ updated: false });
  });

  test("session_id matches a DIFFERENT bot_id's row -> not updated (bot_id is part of the match, not just a label)", () => {
    const deps = baseDeps();
    seedSession(deps, "bot-01", "sess-1");
    const result = handleTelemetryReport({ bot_id: "bot-02", session_id: "sess-1" }, deps);
    expect(result).toEqual({ updated: false });
    const row = deps.db.query(`SELECT used_percentage FROM sessions WHERE id = ?`).get("sess-1") as { used_percentage: number | null };
    expect(row.used_percentage).toBeNull();
  });

  test("bad params shape (missing session_id) -> zod error, nothing written", () => {
    const deps = baseDeps();
    expect(() => handleTelemetryReport({ bot_id: "bot-01" }, deps)).toThrow();
  });

  test("bad params shape (missing bot_id) -> zod error", () => {
    const deps = baseDeps();
    expect(() => handleTelemetryReport({ session_id: "sess-1" }, deps)).toThrow();
  });

  test("unexpected extra field -> zod .strict() rejects", () => {
    const deps = baseDeps();
    expect(() => handleTelemetryReport({ bot_id: "bot-01", session_id: "sess-1", unexpected: true }, deps)).toThrow();
  });
});
