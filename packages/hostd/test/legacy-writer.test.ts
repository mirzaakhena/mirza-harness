import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BotConfig } from "../src/config";
import {
  createLegacyWriter,
  isExpired,
  PENSIUN_DATE,
  type LegacyWriterFsOps,
} from "../src/shim/legacy-writer";

function tmpRoot(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mirza-hostd-legacy-writer-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_TOKEN = "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function makeBotConfig(id: string, workspace: string): BotConfig {
  return { id, telegram_token: VALID_TOKEN, workspace };
}

/** Standard harness: real fs, everything under a fresh tmp root. Mirrors the
 * real production wiring (stateDirFor derives <workspace>/.claude/channels/
 * pty-controller; homeDir houses .claude/agent-registry.json) but every path
 * lands under `root` — never the real ~/.claude. */
function harness(name: string, opts: { fsOps?: Partial<LegacyWriterFsOps>; now?: () => number } = {}) {
  const root = tmpRoot(name);
  const homeDir = path.join(root, "home");
  const bots: Record<string, BotConfig> = {
    "bot-01": makeBotConfig("bot-01", path.join(root, "workspace", "bot-01")),
  };
  const writer = createLegacyWriter({
    stateDirFor: botId => path.join(root, "workspace", botId, ".claude", "channels", "pty-controller"),
    homeDir,
    botConfig: botId => {
      const cfg = bots[botId];
      if (!cfg) throw new Error(`unknown bot ${botId}`);
      return cfg;
    },
    now: opts.now,
    fsOps: opts.fsOps,
  });
  const ptyDir = path.join(root, "workspace", "bot-01", ".claude", "channels", "pty-controller");
  const telegramDir = path.join(root, "workspace", "bot-01", ".claude", "channels", "telegram");
  const registryPath = path.join(homeDir, ".claude", "agent-registry.json");
  return { root, homeDir, writer, ptyDir, telegramDir, registryPath };
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function outboxFiles(dir: string): string[] {
  const outboxDir = path.join(dir, "system-outbox");
  if (!fs.existsSync(outboxDir)) return [];
  return fs.readdirSync(outboxDir);
}

// ---------------------------------------------------------------------------
// onSessionChange
// ---------------------------------------------------------------------------

describe("legacy-writer — onSessionChange", () => {
  test("wrapper.state.json has EXACT keys {session_id, session_name, lifecycle, seq, updated_at_ms}", async () => {
    const h = harness("state-keys", { now: () => 1_000_000 });
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: "task-foo", lifecycle: "busy" });

    const state = readJson(path.join(h.ptyDir, "wrapper.state.json")) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(
      ["session_id", "session_name", "lifecycle", "seq", "updated_at_ms"].sort(),
    );
    expect(state.session_id).toBe("sid-1");
    expect(state.session_name).toBe("task-foo");
    expect(state.lifecycle).toBe("busy");
    expect(state.seq).toBe(1);
    expect(state.updated_at_ms).toBe(1_000_000);
  });

  test("seq increments across successive calls for the same bot", async () => {
    const h = harness("seq-increment");
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: null, lifecycle: "unknown" });
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: "idle", lifecycle: "idle" });
    await h.writer.onSessionChange("bot-01", { session_id: "sid-2", session_name: "task-x", lifecycle: "busy" });

    const state = readJson(path.join(h.ptyDir, "wrapper.state.json")) as { seq: number };
    expect(state.seq).toBe(3);
  });

  test("seq resumes from an existing on-disk wrapper.state.json rather than restarting at 1", async () => {
    const h = harness("seq-resume");
    fs.mkdirSync(h.ptyDir, { recursive: true });
    fs.writeFileSync(
      path.join(h.ptyDir, "wrapper.state.json"),
      JSON.stringify({ session_id: "old", session_name: "idle", lifecycle: "idle", seq: 41, updated_at_ms: 1 }),
    );
    await h.writer.onSessionChange("bot-01", { session_id: "sid-new", session_name: "task-y", lifecycle: "busy" });
    const state = readJson(path.join(h.ptyDir, "wrapper.state.json")) as { seq: number };
    expect(state.seq).toBe(42);
  });

  test("wrapper.current_session_id is overwritten ONLY when a concrete id is present", async () => {
    const h = harness("current-id-overwrite");
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: "task-a", lifecycle: "busy" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.current_session_id"), "utf8")).toBe("sid-1");

    // A lifecycle/name-only change (session_id: null) must NOT clobber the file.
    await h.writer.onSessionChange("bot-01", { session_id: null, session_name: "done-a", lifecycle: "transitioning" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.current_session_id"), "utf8")).toBe("sid-1");

    await h.writer.onSessionChange("bot-01", { session_id: "sid-2", session_name: "task-b", lifecycle: "busy" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.current_session_id"), "utf8")).toBe("sid-2");
  });

  test("wrapper.current_session_name is ALWAYS overwritten; null/empty name -> empty file", async () => {
    const h = harness("current-name-overwrite");
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: "task-a", lifecycle: "busy" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.current_session_name"), "utf8")).toBe("task-a");

    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: null, lifecycle: "resetting" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.current_session_name"), "utf8")).toBe("");
  });

  test("system-outbox event has EXACT keys {id, ts, type, sessionId, sessionName} (camelCase)", async () => {
    const h = harness("outbox-keys");
    await h.writer.onSessionChange("bot-01", { session_id: "sid-9", session_name: "task-z", lifecycle: "busy" });

    const files = outboxFiles(h.telegramDir);
    expect(files.length).toBe(1);
    const payload = readJson(path.join(h.telegramDir, "system-outbox", files[0]!)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["id", "ts", "type", "sessionId", "sessionName"].sort());
    expect(payload.type).toBe("session-change");
    expect(payload.sessionId).toBe("sid-9");
    expect(payload.sessionName).toBe("task-z");
    expect(typeof payload.id).toBe("string");
    expect(typeof payload.ts).toBe("string");
  });

  test("atomic write: no leftover .tmp. files after onSessionChange settles", async () => {
    const h = harness("atomic-no-leftovers");
    await h.writer.onSessionChange("bot-01", { session_id: "sid-1", session_name: "task-a", lifecycle: "busy" });
    const leftovers = fs.readdirSync(h.ptyDir).filter(f => f.includes(".tmp."));
    expect(leftovers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// onHeartbeat
// ---------------------------------------------------------------------------

describe("legacy-writer — onHeartbeat", () => {
  test("writes wrapper.heartbeat as an ISO timestamp string", async () => {
    const h = harness("heartbeat", { now: () => Date.parse("2026-07-05T12:00:00.000Z") });
    await h.writer.onHeartbeat("bot-01");
    const content = fs.readFileSync(path.join(h.ptyDir, "wrapper.heartbeat"), "utf8");
    expect(content).toBe("2026-07-05T12:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// onBoot
// ---------------------------------------------------------------------------

describe("legacy-writer — onBoot", () => {
  test("writes wrapper.pid as the numeric pid (plain text, not JSON)", async () => {
    const h = harness("boot-pid");
    await h.writer.onBoot("bot-01", { pid: 4242, plugin_version: "1.2.3", wrapper_version: "0.0.7" });
    expect(fs.readFileSync(path.join(h.ptyDir, "wrapper.pid"), "utf8")).toBe("4242");
  });

  test("writes wrapper.version with EXACT keys plugin_version/wrapper_version (not camelCase)", async () => {
    const h = harness("boot-version");
    await h.writer.onBoot("bot-01", { pid: 1, plugin_version: "1.2.3", wrapper_version: "0.0.7" });
    const version = readJson(path.join(h.ptyDir, "wrapper.version")) as Record<string, unknown>;
    expect(Object.keys(version).sort()).toEqual(["plugin_version", "wrapper_version"]);
    expect(version.plugin_version).toBe("1.2.3");
    expect(version.wrapper_version).toBe("0.0.7");
  });

  test("registers bot in agent-registry.json with schema_version:1 and EXACT entry keys", async () => {
    const h = harness("boot-registry", { now: () => Date.parse("2026-07-05T00:00:00.000Z") });
    await h.writer.onBoot("bot-01", { pid: 999, plugin_version: "1.0.0", wrapper_version: "0.0.5" });

    const reg = readJson(h.registryPath) as { schema_version: number; agents: Record<string, unknown> };
    expect(reg.schema_version).toBe(1);
    const entry = reg.agents["bot-01"] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual(
      ["project_dir", "state_dir", "registered_at", "last_heartbeat", "wrapper_pid"].sort(),
    );
    expect(entry.wrapper_pid).toBe(999);
    expect(entry.registered_at).toBe("2026-07-05T00:00:00.000Z");
    expect(entry.last_heartbeat).toBe("2026-07-05T00:00:00.000Z");
  });

  test("registry entry key is basename(workspace) (kode acuan SELF_AGENT_NAME parity), not bot.id verbatim", async () => {
    const root = tmpRoot("boot-registry-name");
    const homeDir = path.join(root, "home");
    const cfg = makeBotConfig("pilot-internal-id", path.join(root, "fleet", "bot-07"));
    const writer = createLegacyWriter({
      stateDirFor: () => path.join(root, "state"),
      homeDir,
      botConfig: () => cfg,
    });
    await writer.onBoot("pilot-internal-id", { pid: 1, plugin_version: null, wrapper_version: null });
    const reg = readJson(path.join(homeDir, ".claude", "agent-registry.json")) as { agents: Record<string, unknown> };
    expect(reg.agents["bot-07"]).toBeDefined();
    expect(reg.agents["pilot-internal-id"]).toBeUndefined();
  });

  test("re-registering preserves the original registered_at but bumps last_heartbeat", async () => {
    const h = harness("boot-reregister", { now: () => 1_000 });
    await h.writer.onBoot("bot-01", { pid: 1, plugin_version: null, wrapper_version: null });

    const h2 = harness("boot-reregister-2", { now: () => 2_000 });
    // reuse same registry path by pointing a second writer instance at the same homeDir
    const writer2 = createLegacyWriter({
      stateDirFor: botId => path.join(h.root, "workspace", botId, ".claude", "channels", "pty-controller"),
      homeDir: h.homeDir,
      botConfig: () => makeBotConfig("bot-01", path.join(h.root, "workspace", "bot-01")),
      now: () => 5_000,
    });
    await writer2.onBoot("bot-01", { pid: 2, plugin_version: null, wrapper_version: null });

    const reg = readJson(h.registryPath) as { agents: Record<string, { registered_at: string; last_heartbeat: string; wrapper_pid: number }> };
    expect(reg.agents["bot-01"]!.registered_at).toBe(new Date(1_000).toISOString());
    expect(reg.agents["bot-01"]!.last_heartbeat).toBe(new Date(5_000).toISOString());
    expect(reg.agents["bot-01"]!.wrapper_pid).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// onShutdown
// ---------------------------------------------------------------------------

describe("legacy-writer — onShutdown", () => {
  test("removes wrapper.pid and unregisters the bot from agent-registry.json", async () => {
    const h = harness("shutdown");
    await h.writer.onBoot("bot-01", { pid: 55, plugin_version: null, wrapper_version: null });
    expect(fs.existsSync(path.join(h.ptyDir, "wrapper.pid"))).toBe(true);

    await h.writer.onShutdown("bot-01");
    expect(fs.existsSync(path.join(h.ptyDir, "wrapper.pid"))).toBe(false);
    const reg = readJson(h.registryPath) as { agents: Record<string, unknown> };
    expect(reg.agents["bot-01"]).toBeUndefined();
  });

  test("shutdown without a prior boot is a no-op, not a throw", async () => {
    const h = harness("shutdown-noop");
    await expect(h.writer.onShutdown("bot-01")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateRegistryHeartbeat
// ---------------------------------------------------------------------------

describe("legacy-writer — updateRegistryHeartbeat", () => {
  test("bumps last_heartbeat for an already-registered bot", async () => {
    let clock = 1_000;
    const h = harness("registry-heartbeat", { now: () => clock });
    await h.writer.onBoot("bot-01", { pid: 7, plugin_version: null, wrapper_version: null });
    clock = 9_999;
    await h.writer.updateRegistryHeartbeat("bot-01");
    const reg = readJson(h.registryPath) as { agents: Record<string, { last_heartbeat: string }> };
    expect(reg.agents["bot-01"]!.last_heartbeat).toBe(new Date(9_999).toISOString());
  });

  test("is a no-op for a bot never registered", async () => {
    const h = harness("registry-heartbeat-unregistered");
    await expect(h.writer.updateRegistryHeartbeat("bot-01")).resolves.toBeUndefined();
    expect(fs.existsSync(h.registryPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// agent-registry.json lock (O_EXCL) — concurrent writers
// ---------------------------------------------------------------------------

describe("legacy-writer — agent-registry lock (O_EXCL)", () => {
  test("two concurrent onBoot calls for different bots serialize instead of corrupting the file", async () => {
    const root = tmpRoot("lock-concurrent");
    const homeDir = path.join(root, "home");
    const cfgs: Record<string, BotConfig> = {
      "bot-a": makeBotConfig("bot-a", path.join(root, "workspace", "bot-a")),
      "bot-b": makeBotConfig("bot-b", path.join(root, "workspace", "bot-b")),
    };
    const writer = createLegacyWriter({
      stateDirFor: botId => path.join(root, "workspace", botId, ".claude", "channels", "pty-controller"),
      homeDir,
      botConfig: botId => cfgs[botId]!,
    });

    await Promise.all([
      writer.onBoot("bot-a", { pid: 1, plugin_version: null, wrapper_version: null }),
      writer.onBoot("bot-b", { pid: 2, plugin_version: null, wrapper_version: null }),
    ]);

    const reg = readJson(path.join(homeDir, ".claude", "agent-registry.json")) as { agents: Record<string, unknown> };
    expect(reg.agents["bot-a"]).toBeDefined();
    expect(reg.agents["bot-b"]).toBeDefined();
    expect(Object.keys(reg.agents).length).toBe(2);
  });

  test("a lock held by another writer forces the second acquirer to wait/retry (EEXIST -> eventual success)", async () => {
    const root = tmpRoot("lock-retry");
    const homeDir = path.join(root, "home");
    const registryDir = path.join(homeDir, ".claude");
    fs.mkdirSync(registryDir, { recursive: true });
    const lockPath = path.join(registryDir, "agent-registry.json.lock");
    // Pre-hold the lock file (simulating another writer already inside its critical section).
    fs.writeFileSync(lockPath, "");

    const cfg = makeBotConfig("bot-01", path.join(root, "workspace", "bot-01"));
    const writer = createLegacyWriter({
      stateDirFor: () => path.join(root, "state"),
      homeDir,
      botConfig: () => cfg,
      lockTimeoutMs: 1_000,
      lockRetryMs: 20,
    });

    let openAttempts = 0;
    const bootPromise = writer.onBoot("bot-01", { pid: 1, plugin_version: null, wrapper_version: null });

    // release the lock shortly after the writer starts retrying
    setTimeout(() => {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }, 60);

    await bootPromise; // must resolve once the lock is released, not hang or throw
    const reg = readJson(path.join(registryDir, "agent-registry.json")) as { agents: Record<string, unknown> };
    expect(reg.agents["bot-01"]).toBeDefined();
    void openAttempts;
  });

  test("lock acquisition throws after lockTimeoutMs if never released", async () => {
    const root = tmpRoot("lock-timeout");
    const homeDir = path.join(root, "home");
    const registryDir = path.join(homeDir, ".claude");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, "agent-registry.json.lock"), "");

    const cfg = makeBotConfig("bot-01", path.join(root, "workspace", "bot-01"));
    const writer = createLegacyWriter({
      stateDirFor: () => path.join(root, "state"),
      homeDir,
      botConfig: () => cfg,
      lockTimeoutMs: 100,
      lockRetryMs: 15,
    });

    await expect(writer.onBoot("bot-01", { pid: 1, plugin_version: null, wrapper_version: null })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SCAR-022 retry (EPERM/EBUSY) threaded through from atomic-write.ts
// ---------------------------------------------------------------------------

describe("legacy-writer — SCAR-022 retry on plain files", () => {
  test("a transient EPERM on wrapper.heartbeat's rename is retried, not fatal", async () => {
    let renameCalls = 0;
    const fsOps: Partial<LegacyWriterFsOps> = {
      rename: (from, to) => {
        renameCalls++;
        if (renameCalls === 1) {
          const err = new Error("EPERM") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        fs.renameSync(from, to);
      },
    };
    const h = harness("scar022-heartbeat", { fsOps });
    await h.writer.onHeartbeat("bot-01");
    expect(renameCalls).toBe(2);
    expect(fs.existsSync(path.join(h.ptyDir, "wrapper.heartbeat"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PENSIUN_DATE / isExpired
// ---------------------------------------------------------------------------

describe("legacy-writer — PENSIUN_DATE / isExpired", () => {
  test("isExpired is false before PENSIUN_DATE and true after", () => {
    const before = PENSIUN_DATE.getTime() - 1;
    const after = PENSIUN_DATE.getTime() + 1;
    expect(isExpired(before)).toBe(false);
    expect(isExpired(after)).toBe(true);
  });

  test("writer.isExpired uses the injected clock by default", async () => {
    const h = harness("pensiun-writer-clock", { now: () => PENSIUN_DATE.getTime() + 1 });
    expect(h.writer.isExpired()).toBe(true);
  });
});
