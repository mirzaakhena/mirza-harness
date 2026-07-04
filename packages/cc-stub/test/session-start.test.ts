import { describe, expect, test } from "bun:test";
import net from "node:net";
import {
  parseSessionStartInput,
  formatHookOutput,
  reportSessionStarted,
  callHostdOnce,
  type SessionStartedParams,
} from "../hooks/session-start";

describe("parseSessionStartInput", () => {
  test("valid JSON with session_id/source/cwd -> parsed as-is", () => {
    const raw = JSON.stringify({ session_id: "sess-1", source: "startup", cwd: "C:/workspace/bot-03", hook_event_name: "SessionStart" });
    expect(parseSessionStartInput(raw, "C:/fallback")).toEqual({ session_id: "sess-1", source: "startup", cwd: "C:/workspace/bot-03" });
  });

  test("missing cwd in payload -> falls back to cwdFallback param", () => {
    const raw = JSON.stringify({ session_id: "sess-1", source: "resume" });
    expect(parseSessionStartInput(raw, "C:/fallback")).toEqual({ session_id: "sess-1", source: "resume", cwd: "C:/fallback" });
  });

  test("missing source in payload -> defaults to 'unknown'", () => {
    const raw = JSON.stringify({ session_id: "sess-1", cwd: "C:/workspace/bot-03" });
    expect(parseSessionStartInput(raw, "C:/fallback")).toEqual({ session_id: "sess-1", source: "unknown", cwd: "C:/workspace/bot-03" });
  });

  test("missing session_id -> null (nothing worth reporting)", () => {
    const raw = JSON.stringify({ source: "startup", cwd: "C:/workspace/bot-03" });
    expect(parseSessionStartInput(raw, "C:/fallback")).toBeNull();
  });

  test("empty-string session_id -> null", () => {
    const raw = JSON.stringify({ session_id: "", cwd: "C:/workspace/bot-03" });
    expect(parseSessionStartInput(raw, "C:/fallback")).toBeNull();
  });

  test("unparseable JSON -> null, not a throw", () => {
    expect(parseSessionStartInput("not json{{{", "C:/fallback")).toBeNull();
  });

  test("empty stdin -> null", () => {
    expect(parseSessionStartInput("", "C:/fallback")).toBeNull();
  });
});

describe("formatHookOutput", () => {
  test("wraps additionalContext in CC's SessionStart hookSpecificOutput shape", () => {
    const out = JSON.parse(formatHookOutput('Current session name: "idle"'));
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: 'Current session name: "idle"',
      },
    });
  });
});

describe("reportSessionStarted — POST via injected `call`", () => {
  const params: SessionStartedParams = { bot_id: "bot-03", session_id: "sess-1", source: "startup", cwd: "C:/workspace/bot-03" };

  test("POST benar: sends session.started with the exact params, additionalContext from the reply is printed as hook output", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const output = await reportSessionStarted(params, {
      call: async (method, callParams) => {
        calls.push({ method, params: callParams });
        return { additionalContext: 'Current session name: "my-session"' };
      },
    });

    expect(calls).toEqual([{ method: "session.started", params }]);
    expect(JSON.parse(output!)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: 'Current session name: "my-session"',
      },
    });
  });

  test("hostd unreachable (call() rejects) -> returns null, hook stays silent (exit 0 path)", async () => {
    const output = await reportSessionStarted(params, {
      call: async () => {
        throw new Error("hostd unreachable");
      },
    });
    expect(output).toBeNull();
  });

  test("hostd replies without a usable additionalContext -> null, not a crash", async () => {
    const output = await reportSessionStarted(params, { call: async () => ({}) });
    expect(output).toBeNull();
  });

  test("hostd replies with non-string additionalContext -> null", async () => {
    const output = await reportSessionStarted(params, { call: async () => ({ additionalContext: 42 }) });
    expect(output).toBeNull();
  });

  test("hostd replies with empty-string additionalContext -> null", async () => {
    const output = await reportSessionStarted(params, { call: async () => ({ additionalContext: "" }) });
    expect(output).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// callHostdOnce — real named-pipe round trip against a minimal mock hostd
// (mirrors ipc-client.test.ts's `startMockHostd` pattern), verifying this
// one-shot client does NOT send `session.register` (unlike ipc-client.ts's
// connectHostd — see session-start.ts's module docstring for why that would
// be wrong here).
// ---------------------------------------------------------------------------

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

describe("callHostdOnce", () => {
  test("connects, sends ONE request (no session.register), resolves with the correlated result, no lingering connection", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-session-start-test-ok-${process.pid}`;
    const receivedMethods: string[] = [];
    const server = await startMockHostd(pipeName, (msg, sock) => {
      receivedMethods.push(msg.method);
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { additionalContext: 'Current session name: "idle"' } }) + "\n");
    });

    const result = await callHostdOnce(pipeName, "session.started", { bot_id: "bot-03", session_id: "s1", source: "startup", cwd: "C:/x" });

    expect(result).toEqual({ additionalContext: 'Current session name: "idle"' });
    expect(receivedMethods).toEqual(["session.started"]); // never sent session.register

    await closeServer(server);
  });

  test("hostd replies with an RpcFailure -> rejects with the server's error message", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-session-start-test-err-${process.pid}`;
    const server = await startMockHostd(pipeName, (msg, sock) => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "params tak valid" } }) + "\n");
    });

    await expect(callHostdOnce(pipeName, "session.started", {})).rejects.toThrow("params tak valid");

    await closeServer(server);
  });

  test("no server listening on the pipe -> rejects fast with 'hostd unreachable', never blocks for the full timeout", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-session-start-test-unreachable-${process.pid}`;
    const start = Date.now();
    await expect(callHostdOnce(pipeName, "session.started", {}, 5000)).rejects.toThrow("hostd unreachable");
    expect(Date.now() - start).toBeLessThan(4000); // well under the 5s timeoutMs — connection error fires immediately
  });
});
