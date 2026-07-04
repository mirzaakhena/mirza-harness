#!/usr/bin/env bun
/**
 * Task H1, Fase 2 — SessionStart hook: reports `{bot_id, session_id, source,
 * cwd}` to hostd via RPC `session.started`, then prints hostd's
 * `additionalContext` back to Claude Code verbatim.
 *
 * Replaces `plugins/telegram/hooks/session-name-context.ts` (mirza-marketplace,
 * recon-hooks.md §A): that hook read the session name from two shim files
 * (`wrapper.current_session_name` / a registry keyed by sid) that could lag
 * each other. hostd's `sessions` table (INFRA-5) is now the single writer of
 * that name — the same row `agent_status`/`agent.status` reads — so this hook
 * carries no name-resolution logic of its own; it just asks hostd.
 *
 * This is also hook-inversion §5 step 2 (recon-hooks.md §B): a fresh Claude
 * Code session firing SessionStart is the signal hostd's bot-supervisor was
 * waiting on to release the `/clear` barrier it armed in step 1
 * (`BotSupervisor.clearSession()` -> `sessions.lifecycle='resetting'`) — see
 * `rpc-handlers.ts`'s `handleSessionStarted` for the hostd side.
 *
 * Fails silent end-to-end: unreadable stdin, unparseable/incomplete JSON, or
 * hostd unreachable/timeout all fall through to "print nothing, exit 0" —
 * this hook must NEVER block or delay SessionStart. Unlike trailer-guard.ts
 * (a security gate with a real fail-closed branch), there is no decision
 * here worth blocking on — only a nice-to-have context injection.
 *
 * Deliberately does NOT reuse `../src/ipc-client.ts`'s `connectHostd`: that
 * client sends `session.register {bot_id}` on every connect, which
 * OVERWRITES hostd's `connections` map entry (server.ts) for this bot_id —
 * fine for cc-stub's own long-lived MCP stdio process (the intended caller),
 * but WRONG for this hook: it runs as a short-lived one-shot process on every
 * SessionStart, so registering (then immediately disconnecting) would race
 * with — and can clobber — the real persistent registration cc-stub's own
 * process holds for `pushEvent`/`isRegistered`. `callHostdOnce` below is a
 * minimal, self-contained connect -> single request -> read one reply ->
 * disconnect, with no registration side effect at all.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { PIPE_NAME_DEFAULT, RpcRequest, parseRpcMessage, type RpcRequestT } from "@mirza-harness/shared";
import { resolveBotId } from "../src/tools";

/** Hook must not block SessionStart for long — shorter than ipc-client.ts's 10s persistent-client default. */
const CALL_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// stdin parsing — CC's SessionStart hook payload: {session_id, transcript_path,
// cwd, hook_event_name, source} (source: "startup" | "resume" | "clear" |
// "compact"). Only session_id/source/cwd matter here.
// ---------------------------------------------------------------------------

export interface SessionStartedParams {
  bot_id: string;
  session_id: string;
  source: string;
  cwd: string;
}

/**
 * Parse CC's SessionStart stdin JSON into the fields `session.started` needs
 * (bot_id filled in separately by the caller — see `resolveBotId`). Returns
 * `null` if the payload isn't JSON or lacks a non-empty `session_id` — there
 * is nothing meaningful to report to hostd without it, and this hook fails
 * silent rather than guessing.
 */
export function parseSessionStartInput(raw: string, cwdFallback: string): Omit<SessionStartedParams, "bot_id"> | null {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = input as Record<string, unknown> | null;
  const sessionId = obj?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const source = typeof obj?.source === "string" && obj.source.length > 0 ? obj.source : "unknown";
  const cwd = typeof obj?.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : cwdFallback;
  return { session_id: sessionId, source, cwd };
}

/** CC SessionStart hook output shape (stdout, JSON). */
export function formatHookOutput(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

// ---------------------------------------------------------------------------
// Core logic — `call` injectable (mirrors ../src/tools.ts's `ToolCallDeps`
// pattern) so tests exercise "POST benar / additionalContext dari balasan"
// and "hostd tak terjangkau -> diam" without a real named pipe.
// ---------------------------------------------------------------------------

export interface SessionStartDeps {
  call: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * Report `params` to hostd's `session.started` and return the ready-to-print
 * hook-output string, or `null` if anything went wrong (hostd unreachable/
 * timeout/error, or a malformed reply missing a non-empty `additionalContext`
 * string) — caller prints nothing in that case, satisfying the "diam, jangan
 * blokir SessionStart" requirement.
 */
export async function reportSessionStarted(params: SessionStartedParams, deps: SessionStartDeps): Promise<string | null> {
  let result: unknown;
  try {
    result = await deps.call("session.started", params);
  } catch {
    return null;
  }
  const additionalContext = (result as { additionalContext?: unknown } | null)?.additionalContext;
  if (typeof additionalContext !== "string" || additionalContext.length === 0) return null;
  return formatHookOutput(additionalContext);
}

// ---------------------------------------------------------------------------
// One-shot IPC call — connect, send ONE request, resolve/reject on the first
// correlated reply, then the caller closes the socket. No `session.register`
// (see module docstring above for why).
// ---------------------------------------------------------------------------

export function callHostdOnce(pipeName: string, method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = "";
    const sock = net.connect(pipeName);

    const timer = setTimeout(() => {
      finish(new Error(`timeout menunggu balasan '${method}' dari hostd`));
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();

    function finish(err: Error | null, result?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    }

    sock.on("connect", () => {
      const req: RpcRequestT = RpcRequest.parse({ jsonrpc: "2.0", id: 1, method, params });
      sock.write(JSON.stringify(req) + "\n");
    });

    sock.on("data", d => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      if (!line) return;
      try {
        const msg = parseRpcMessage(line);
        if ("method" in msg) return; // stray event (unexpected on this one-shot connection) — keep waiting for the real reply
        if ("error" in msg) finish(new Error(msg.error.message));
        else finish(null, msg.result);
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });

    // A raw socket-level error (ENOENT/ECONNREFUSED — no hostd listening on
    // this pipe) is normalized to "hostd unreachable" (same wording
    // ipc-client.ts's `call()` uses) rather than surfaced as Node's raw
    // connect-error text — callers (`reportSessionStarted`) only branch on
    // success/failure here, but a consistent message matters for anyone
    // reading hostd/hook logs. The original message is kept alongside for
    // debugging.
    sock.on("error", err => finish(new Error(`hostd unreachable: ${err.message}`)));
    sock.on("close", () => finish(new Error("hostd unreachable")));
  });
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const parsed = parseSessionStartInput(raw, process.cwd());
  if (!parsed) return;

  const botId = resolveBotId();
  const params: SessionStartedParams = { ...parsed, bot_id: botId };
  const pipeName = process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;

  const output = await reportSessionStarted(params, {
    call: (method, callParams) => callHostdOnce(pipeName, method, callParams),
  });
  if (output) process.stdout.write(output);
}

if (import.meta.main) void main();
