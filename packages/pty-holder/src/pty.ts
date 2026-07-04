import { spawn, type IPty } from "node-pty";
import type { InjectStep } from "./inject";

/**
 * PTY spawn chain + paced-write executor. Touches the native `node-pty`
 * module, so — unlike `inject.ts`/`ipc.ts` — this file is NEVER imported
 * from a `bun:test` file (native binary, compiled for Node's ABI; loading
 * it under Bun's test runner is unsupported — see the package README and
 * `test-integration.mjs` for how this file is actually exercised).
 *
 * Spawn chain ported verbatim from kode acuan
 * (`plugins/pty-controller/wrapper/src/wrapper.ts:553-587,255-267,368-369`,
 * SCAR-025): Windows launches `cmd.exe /c "<claude command>"`; Unix launches
 * an interactive login shell (`$SHELL -l -i -c "<claude command>"`) so
 * `claude` resolves through the user's PATH/rc-files — skipping the shell
 * triggers a `posix_spawnp ENOENT` for the npm-installed shim. Unlike the
 * reference wrapper, this holder carries NO session/resume knowledge: it
 * always launches the same `BASE_CLAUDE_ARGS`, never a `--resume <id>`
 * variant — that decision belongs to whatever process is composing the
 * command / env before spawning this child.
 */

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// Same defaults as kode acuan: skip the interactive permission prompts and
// preload mirza-marketplace's telegram channel plugin. Override with
// CLAUDE_ARGS (set to "" for vanilla `claude`, or any custom flag string).
const DEFAULT_CLAUDE_ARGS =
  "--dangerously-skip-permissions " + "--dangerously-load-development-channels plugin:telegram@mirza-marketplace";
const BASE_CLAUDE_ARGS = (process.env.CLAUDE_ARGS ?? DEFAULT_CLAUDE_ARGS)
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const isWindows = process.platform === "win32";
const userShell = process.env.SHELL || "/bin/sh";
const shell = isWindows ? "cmd.exe" : userShell;

export interface SpawnPtyOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn Claude Code under a fresh PTY (SCAR-025 spawn chain). `cols`/`rows`
 * default to 100x30 (kode acuan's fallback when the parent has no real
 * terminal size to hand down); `cwd` defaults to `process.cwd()`; `env` is
 * merged over `process.env` (parent-supplied overrides win).
 */
export function spawnClaudePty(opts: SpawnPtyOptions = {}): IPty {
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  const claudeCmd = [CLAUDE_BIN, ...BASE_CLAUDE_ARGS].join(" ");
  const args = isWindows ? ["/c", claudeCmd] : ["-l", "-i", "-c", claudeCmd];
  return spawn(shell, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd ?? process.cwd(),
    env: { ...(process.env as Record<string, string | undefined>), ...(opts.env ?? {}) },
  });
}

/**
 * Execute a paced write plan (from `inject.ts`'s `planInject`/`planInjectSlash`)
 * against a live PTY: each step's `text` is written `step.delayMs` after the
 * plan starts, and `onDone` fires once the LAST write has actually gone out
 * — this is the "keystrokes written" ack point (the IPC `injected` event),
 * not a claim that Claude Code has processed them.
 */
export function runPlan(pty: IPty, steps: readonly InjectStep[], onDone?: () => void): void {
  if (steps.length === 0) {
    onDone?.();
    return;
  }
  for (const step of steps) {
    setTimeout(() => pty.write(step.text), step.delayMs);
  }
  const lastDelayMs = steps[steps.length - 1]!.delayMs;
  setTimeout(() => onDone?.(), lastDelayMs);
}
