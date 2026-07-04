import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { parseRpcMessage, type RpcRequestT } from "@mirza-harness/shared";
import { planInject, planInjectSlash } from "./inject";
import { InjectParams, InjectSlashParams, ResizeParams, makeError, makeEvent, makeResult, writeLine } from "./ipc";
import { runPlan, spawnClaudePty } from "./pty";

/**
 * pty-holder entrypoint: a thin child process that holds one PTY-spawned
 * Claude Code session and speaks the `ipc.ts` NDJSON JSON-RPC protocol with
 * its parent over stdio — nothing else. It has NO knowledge of session ids,
 * session names, or the supervisor's injection barrier/queue (recon-wrapper
 * §A); those all moved up a layer. Run with `node --import tsx src/main.ts`
 * (or a build step) — see the package README for why Node, not Bun, and why
 * `tsx` rather than a bare `.ts` entry.
 *
 * stdin: NDJSON `RpcRequest`s (`inject`/`inject-slash`/`resize`/`shutdown`).
 * stdout: NDJSON `RpcResponse`s (one per request) plus events
 * (`pty-exit`/`pty-error`/`injected`) — see ipc.ts's module doc for the full
 * contract. Raw PTY output is intentionally NOT forwarded on stdout (that
 * stream is reserved for the protocol); nothing in this package parses or
 * needs the terminal's rendered contents.
 */

// VER-1: report this package's OWN version (from its package.json), never a
// hardcoded/duplicated string.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const VERSION: string = (JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string })
  .version;

function emitEvent(method: string, params: unknown, callback?: (err?: Error | null) => void): void {
  writeLine(process.stdout, makeEvent(method, params), callback);
}

function respond(id: RpcRequestT["id"], result: unknown, callback?: (err?: Error | null) => void): void {
  writeLine(process.stdout, makeResult(id, result), callback);
}

function respondErr(id: RpcRequestT["id"], code: number, message: string): void {
  writeLine(process.stdout, makeError(id, code, message));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Bounded grace window for the explicit `shutdown()` path (S1 exit
 * contract — see README "Exit-time contract (S1)"). node-pty's Windows
 * ConPTY console-list helper fork (`conpty_console_list_agent`) throws an
 * uncaught `AttachConsole failed` IN ITS OWN FORKED PROCESS whenever this
 * holder's stdio is piped with no attached console — i.e. on every normal
 * spawn shape a supervisor uses — and afterwards can keep a handle alive
 * for 6-12+ seconds, stalling the event loop from draining naturally. We
 * therefore never rely on `process.exitCode` + an empty loop to exit;
 * `process.exit()` is called explicitly, bounded by this window rather
 * than by however long that helper's handle takes to release.
 */
const SHUTDOWN_GRACE_MS = 1500;

export function main(): void {
  process.stderr.write(`pty-holder v${VERSION} starting (pid ${process.pid})\n`);

  let pty: IPty;
  try {
    pty = spawnClaudePty();
  } catch (err) {
    emitEvent("pty-error", { message: errMessage(err) });
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`pty-holder: spawned claude (pty pid ${pty.pid})\n`);

  let shuttingDown = false;
  let exitTimer: NodeJS.Timeout | undefined;
  let pendingExitCode = 0;

  function clearExitTimer(): void {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = undefined;
    }
  }

  /** The one and only place that actually terminates this process. Always
   * explicit — never leans on the event loop emptying by itself (see
   * SHUTDOWN_GRACE_MS docstring). */
  function forceExit(code: number): void {
    clearExitTimer();
    process.exitCode = code;
    process.exit(code);
  }

  /** Explicit shutdown path (RPC `shutdown` request or SIGTERM). Layer 2 of
   * the S1 fix: try a graceful `pty.kill()` (best-effort; wrapped since the
   * ConPTY helper fork's crash happens in a separate process and can't be
   * caught here regardless), then force-exit after a bounded grace window
   * instead of waiting for the event loop to drain on its own. If the held
   * process reports its own exit during the window (see `pty.onExit`
   * below), we short-circuit the wait rather than sitting out the full
   * window. */
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    pendingExitCode = code;
    process.stdin.pause();
    try {
      pty.kill();
    } catch {
      /* Synchronous throws from kill() itself land here and are swallowed
         — but the crash this fix targets (AttachConsole failed in the
         ConPTY console-list helper fork) happens asynchronously in that
         forked process, not here, so this catch was never what mattered;
         the grace-window force-exit below is what actually protects us. */
    }
    exitTimer = setTimeout(() => forceExit(pendingExitCode), SHUTDOWN_GRACE_MS);
  }

  pty.onExit(({ exitCode, signal }) => {
    emitEvent("pty-exit", { code: exitCode, signal: signal ?? null }, () => {
      if (shuttingDown) {
        // We're already inside shutdown()'s grace window (or racing it):
        // the held process just confirmed it died on its own, so stop
        // waiting out the rest of the window and exit now.
        forceExit(pendingExitCode);
        return;
      }
      // Layer 1 of the S1 fix — natural-exit path: the held process
      // already died by itself, so its pty handle is already dead. Do NOT
      // call pty.kill() again here — that is exactly the redundant call
      // that fires the ConPTY console-list helper's AttachConsole crash on
      // the normal per-exit path every single time. Go straight to exit.
      shuttingDown = true;
      process.stdin.pause();
      forceExit(exitCode ?? 0);
    });
  });

  function dispatch(req: RpcRequestT): void {
    switch (req.method) {
      case "inject": {
        const parsed = InjectParams.safeParse(req.params);
        if (!parsed.success) {
          respondErr(req.id, -32602, `invalid params for 'inject': ${parsed.error.message}`);
          return;
        }
        const { id, text, submit } = parsed.data;
        respond(req.id, { queued: true });
        try {
          runPlan(pty, planInject(text, submit), () => emitEvent("injected", { id }));
        } catch (err) {
          emitEvent("pty-error", { message: errMessage(err) });
        }
        return;
      }
      case "inject-slash": {
        const parsed = InjectSlashParams.safeParse(req.params);
        if (!parsed.success) {
          respondErr(req.id, -32602, `invalid params for 'inject-slash': ${parsed.error.message}`);
          return;
        }
        const { id, command, confirmAfterMs } = parsed.data;
        respond(req.id, { queued: true });
        try {
          runPlan(pty, planInjectSlash(command, confirmAfterMs), () => emitEvent("injected", { id }));
        } catch (err) {
          emitEvent("pty-error", { message: errMessage(err) });
        }
        return;
      }
      case "resize": {
        const parsed = ResizeParams.safeParse(req.params);
        if (!parsed.success) {
          respondErr(req.id, -32602, `invalid params for 'resize': ${parsed.error.message}`);
          return;
        }
        try {
          pty.resize(parsed.data.cols, parsed.data.rows);
          respond(req.id, { ok: true });
        } catch (err) {
          const message = errMessage(err);
          emitEvent("pty-error", { message });
          respondErr(req.id, -32000, message);
        }
        return;
      }
      case "shutdown": {
        // Don't call shutdown() (which may process.exit()) until the "ok"
        // response has actually been handed off on stdout — otherwise a
        // fast exit can race the write and the supervisor never sees the
        // ack (S1 exit contract; see README + SHUTDOWN_GRACE_MS docstring).
        respond(req.id, { ok: true }, () => shutdown(0));
        return;
      }
      default:
        respondErr(req.id, -32601, `unknown method '${req.method}'`);
    }
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = parseRpcMessage(line);
      } catch (err) {
        process.stderr.write(`pty-holder: dropping malformed line from parent: ${errMessage(err)}\n`);
        continue;
      }
      if ("method" in msg && "id" in msg) {
        dispatch(msg);
      } else {
        process.stderr.write(`pty-holder: ignoring unexpected message shape from parent: ${line}\n`);
      }
    }
  });

  process.on("SIGINT", () => {
    try {
      pty.kill("SIGINT");
    } catch {
      /* already dead */
    }
  });
  process.on("SIGTERM", () => shutdown(0));
}

if (import.meta.main) {
  main();
}
