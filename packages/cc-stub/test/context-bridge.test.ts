import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import {
  parseStatusLineInput,
  reportTelemetry,
  resolveChainedStatusLineFile,
  runChainedStatusLine,
  type TelemetryReportParams,
} from "../scripts/context-bridge";

describe("parseStatusLineInput", () => {
  test("full snapshot -> every telemetry field extracted, captured_at_ms from injected clock", () => {
    const raw = JSON.stringify({
      session_id: "sess-1",
      context_window: { used_percentage: 42.5, context_window_size: 200000 },
      model: { display_name: "claude-sonnet-5" },
      effort: { level: "high" },
      cost: { total_cost_usd: 1.23 },
    });
    const result = parseStatusLineInput(raw, "bot-03", () => 999);
    expect(result).toEqual({
      bot_id: "bot-03",
      session_id: "sess-1",
      used_percentage: 42.5,
      context_window_size: 200000,
      model: "claude-sonnet-5",
      effort: "high",
      cost: 1.23,
      captured_at_ms: 999,
    });
  });

  test("session_id only, no context_window/model/effort/cost -> other fields null, not a crash (FUNC-1 parity)", () => {
    const raw = JSON.stringify({ session_id: "sess-1" });
    const result = parseStatusLineInput(raw, "bot-03", () => 999);
    expect(result).toEqual({
      bot_id: "bot-03",
      session_id: "sess-1",
      used_percentage: null,
      context_window_size: null,
      model: null,
      effort: null,
      cost: null,
      captured_at_ms: 999,
    });
  });

  test("missing session_id -> null (nothing worth reporting)", () => {
    const raw = JSON.stringify({ context_window: { used_percentage: 10 } });
    expect(parseStatusLineInput(raw, "bot-03")).toBeNull();
  });

  test("empty-string session_id -> null", () => {
    const raw = JSON.stringify({ session_id: "" });
    expect(parseStatusLineInput(raw, "bot-03")).toBeNull();
  });

  test("unparseable JSON stdin -> null, not a throw (this IS the FUNC-1 fix: never report a null payload)", () => {
    expect(() => parseStatusLineInput("not json{{{", "bot-03")).not.toThrow();
    expect(parseStatusLineInput("not json{{{", "bot-03")).toBeNull();
  });

  test("empty stdin -> null", () => {
    expect(parseStatusLineInput("", "bot-03")).toBeNull();
  });

  test("non-numeric context_window.used_percentage -> null (not coerced, not thrown)", () => {
    const raw = JSON.stringify({ session_id: "sess-1", context_window: { used_percentage: "42%" } });
    const result = parseStatusLineInput(raw, "bot-03", () => 1);
    expect(result?.used_percentage).toBeNull();
  });

  test("empty-string model/effort -> null (not an empty string in the DB)", () => {
    const raw = JSON.stringify({ session_id: "sess-1", model: { display_name: "" }, effort: { level: "" } });
    const result = parseStatusLineInput(raw, "bot-03", () => 1);
    expect(result?.model).toBeNull();
    expect(result?.effort).toBeNull();
  });
});

describe("reportTelemetry", () => {
  const params: TelemetryReportParams = {
    bot_id: "bot-03",
    session_id: "sess-1",
    used_percentage: 50,
    context_window_size: 100000,
    model: "claude-sonnet-5",
    effort: "high",
    cost: 0.5,
    captured_at_ms: 1000,
  };

  test("sends telemetry.report with the exact params", async () => {
    const calls: { method: string; params: unknown }[] = [];
    await reportTelemetry(params, {
      call: async (method, callParams) => {
        calls.push({ method, params: callParams });
        return { updated: true };
      },
    });
    expect(calls).toEqual([{ method: "telemetry.report", params }]);
  });

  test("hostd unreachable (call() rejects) -> resolves without throwing (gagal konek -> tetap lanjut)", async () => {
    await expect(
      reportTelemetry(params, {
        call: async () => {
          throw new Error("hostd unreachable");
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("hostd replies with an RPC error -> still resolves without throwing", async () => {
    await expect(
      reportTelemetry(params, {
        call: async () => {
          throw new Error("params tak valid");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("resolveChainedStatusLineFile", () => {
  test("CLAUDE_PROJECT_DIR set -> <project>/.claude/channels/telegram/chained-statusline", () => {
    const file = resolveChainedStatusLineFile({ CLAUDE_PROJECT_DIR: "C:/workspace/bot-03" });
    expect(file).toBe(join("C:/workspace/bot-03", ".claude", "channels", "telegram", "chained-statusline"));
  });

  test("CLAUDE_PROJECT_DIR unset -> null", () => {
    expect(resolveChainedStatusLineFile({})).toBeNull();
  });

  test("CLAUDE_PROJECT_DIR blank/whitespace -> null", () => {
    expect(resolveChainedStatusLineFile({ CLAUDE_PROJECT_DIR: "   " })).toBeNull();
  });
});

describe("runChainedStatusLine", () => {
  function tmpDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  test("chainFile null -> no-op, does not throw", () => {
    expect(() => runChainedStatusLine(null, "{}")).not.toThrow();
  });

  test("chainFile path doesn't exist -> no-op, does not throw", () => {
    const dir = tmpDir("ctx-bridge-chain-missing-");
    try {
      expect(() => runChainedStatusLine(join(dir, "chained-statusline"), "{}")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chainFile exists but blank -> no-op, does not throw", () => {
    const dir = tmpDir("ctx-bridge-chain-blank-");
    try {
      const file = join(dir, "chained-statusline");
      writeFileSync(file, "   \n");
      expect(() => runChainedStatusLine(file, "{}")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("chainFile exists with a real command -> executed, receives the exact stdin, output forwarded", () => {
    const dir = tmpDir("ctx-bridge-chain-real-");
    try {
      const sentinelOut = join(dir, "sentinel.out");
      const chainCmd =
        process.platform === "win32" ? `more > "${sentinelOut}"` : `cat > "${sentinelOut}"`;
      const chainFile = join(dir, "chained-statusline");
      writeFileSync(chainFile, chainCmd);

      runChainedStatusLine(chainFile, '{"a":1}');

      expect(existsSync(sentinelOut)).toBe(true);
      expect(readFileSync(sentinelOut, "utf8").trim()).toBe('{"a":1}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Full-process integration: spawn the actual script via `bun run`, exercising
// main()'s "chain ALWAYS runs + exit 0" contract end-to-end — including the
// "hostd unreachable" path (no mock hostd listening on the given pipe name)
// and the "hostd reachable" path (a minimal mock hostd captures the
// telemetry.report call it received).
// ---------------------------------------------------------------------------

const SCRIPT = join(import.meta.dir, "..", "scripts", "context-bridge.ts");

function runScript(env: Record<string, string>, stdin: string) {
  return spawnSync("bun", ["run", SCRIPT], {
    env: { ...process.env, ...env },
    input: stdin,
    encoding: "utf-8",
  });
}

/**
 * Async variant of `runScript` — REQUIRED (not just nicer) whenever the test
 * also runs a mock hostd server in THIS same process (e.g. via
 * `startMockHostd` below): `spawnSync` blocks this process's entire event
 * loop until the child exits, so a same-process `net.Server` could never
 * accept/answer the child's connection while `spawnSync` is blocking —
 * guaranteed deadlock, broken only by the child's own IPC timeout. `spawn`
 * (async) keeps this process's event loop running while the child is alive,
 * so the in-process mock hostd can actually service the child's request.
 */
function runScriptAsync(env: Record<string, string>, stdin: string): Promise<{ status: number | null }> {
  return new Promise(resolve => {
    const child = spawn("bun", ["run", SCRIPT], { env: { ...process.env, ...env } });
    child.stdin.end(stdin);
    child.on("close", status => resolve({ status }));
  });
}

function startMockHostd(pipeName: string, handler: (msg: any, sock: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      let buf = "";
      sock.on("data", d => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handler(JSON.parse(line), sock);
        }
      });
    });
    server.on("error", reject);
    server.listen(pipeName, () => resolve(server));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

describe("context-bridge.ts main() — full process", () => {
  test("hostd unreachable -> still chains to the previous statusLine command, exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-bridge-e2e-unreachable-"));
    try {
      const stateDir = join(dir, ".claude", "channels", "telegram");
      mkdirSync(stateDir, { recursive: true });
      const sentinelOut = join(dir, "sentinel.out");
      const chainCmd = process.platform === "win32" ? `more > "${sentinelOut}"` : `cat > "${sentinelOut}"`;
      writeFileSync(join(stateDir, "chained-statusline"), chainCmd);

      const payload = { session_id: "sess-1", context_window: { used_percentage: 10 } };
      const r = runScript(
        {
          CLAUDE_PROJECT_DIR: dir,
          MIRZA_HOSTD_PIPE: `\\\\.\\pipe\\cc-stub-context-bridge-test-unreachable-${process.pid}`,
          MIRZA_BOT_ID: "bot-03",
        },
        JSON.stringify(payload),
      );

      expect(r.status).toBe(0);
      expect(existsSync(sentinelOut)).toBe(true);
      expect(JSON.parse(readFileSync(sentinelOut, "utf8"))).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hostd reachable -> telemetry.report sent with extracted fields, chain still runs, exits 0", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-context-bridge-test-ok-${process.pid}`;
    const received: { method: string; params: any }[] = [];
    const server = await startMockHostd(pipeName, (msg, sock) => {
      received.push({ method: msg.method, params: msg.params });
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { updated: true } }) + "\n");
    });

    const dir = mkdtempSync(join(tmpdir(), "ctx-bridge-e2e-ok-"));
    try {
      const stateDir = join(dir, ".claude", "channels", "telegram");
      mkdirSync(stateDir, { recursive: true });
      const sentinelOut = join(dir, "sentinel.out");
      const chainCmd = process.platform === "win32" ? `more > "${sentinelOut}"` : `cat > "${sentinelOut}"`;
      writeFileSync(join(stateDir, "chained-statusline"), chainCmd);

      const payload = {
        session_id: "sess-1",
        context_window: { used_percentage: 77, context_window_size: 150000 },
        model: { display_name: "claude-sonnet-5" },
        effort: { level: "low" },
        cost: { total_cost_usd: 2.5 },
      };
      const r = await runScriptAsync({ CLAUDE_PROJECT_DIR: dir, MIRZA_HOSTD_PIPE: pipeName, MIRZA_BOT_ID: "bot-03" }, JSON.stringify(payload));

      expect(r.status).toBe(0);
      expect(received).toEqual([
        {
          method: "telemetry.report",
          params: {
            bot_id: "bot-03",
            session_id: "sess-1",
            used_percentage: 77,
            context_window_size: 150000,
            model: "claude-sonnet-5",
            effort: "low",
            cost: 2.5,
            captured_at_ms: expect.any(Number),
          },
        },
      ]);
      expect(existsSync(sentinelOut)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await closeServer(server);
    }
  });

  test("no CLAUDE_PROJECT_DIR (no chain configured) -> still exits 0, no telemetry.report sent (no session_id)", () => {
    const r = runScript({ CLAUDE_PROJECT_DIR: "" }, "not json{{{");
    expect(r.status).toBe(0);
  });
});
