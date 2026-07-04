#!/usr/bin/env node
// Manual integration smoke test for pty-holder — NOT part of `bun test`.
//
// Spawns a REAL PTY (via node-pty) running a plain interactive shell
// (`cmd.exe` on Windows / `$SHELL -i` elsewhere — deliberately NOT `claude`),
// then drives it through this package's actual `planInject`/
// `planInjectSlash`/`runPlan` (the exact code path pty-holder uses to type
// into a live Claude Code session), and asserts the typed text arrives back
// through the shell's own echo intact — proving the chunk/pacing logic
// survives a real platform PTY layer (Windows ConPTY / Unix pty), not just
// the pure-math unit tests in test/inject.test.ts.
//
// Run manually:
//   node --import tsx test-integration.mjs
//   npm run test:integration   (from this package directory)
//   bun run test:integration
//
// `node-pty` is a native module compiled for Node's ABI — this script must
// run under Node, never under `bun test` (see README.md).

import { spawn } from "node-pty";
import { runPlan } from "./src/pty.ts";
import { planInject, planInjectSlash } from "./src/inject.ts";

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await wait(50);
  }
}

function log(msg) {
  process.stdout.write(`[test-integration] ${msg}\n`);
}

function runPlanAsync(pty, steps) {
  return new Promise((resolve, reject) => {
    try {
      runPlan(pty, steps, resolve);
    } catch (err) {
      reject(err);
    }
  });
}

async function main() {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : process.env.SHELL || "/bin/sh";
  const args = isWindows ? [] : ["-i"];

  log(`spawning interactive shell: ${shell} ${args.join(" ")} (NOT claude)`);
  const pty = spawn(shell, args, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  let output = "";
  pty.onData(d => {
    output += d;
  });

  let exited = false;
  let exitInfo = null;
  pty.onExit(info => {
    exited = true;
    exitInfo = info;
  });

  let failures = 0;

  try {
    // Let the shell settle (prompt banner etc.) before typing anything.
    await wait(800);

    // --- Test 1: planInject (chunked typing + submit) round-trips a marker ---
    const marker1 = `PTY_HOLDER_INTEG_${process.pid}_${Date.now()}`;
    const cmd1 = `echo ${marker1}`;
    log(`test 1: planInject — typing '${cmd1}' via chunked pacing`);
    await runPlanAsync(pty, planInject(cmd1, true));
    await waitFor(() => output.includes(marker1), 5000, `marker1 (${marker1}) echoed back`);
    log(`PASS test 1: marker1 observed intact in PTY output`);

    // --- Test 2: planInjectSlash (single-shot write + delayed \r) ---
    const marker2 = `PTY_HOLDER_INTEG_SLASH_${process.pid}_${Date.now()}`;
    const cmd2 = `echo ${marker2}`;
    log(`test 2: planInjectSlash — typing '${cmd2}'`);
    await runPlanAsync(pty, planInjectSlash(cmd2));
    await waitFor(() => output.includes(marker2), 5000, `marker2 (${marker2}) echoed back`);
    log(`PASS test 2: marker2 observed intact in PTY output`);

    // --- Test 3: a long body spanning multiple 100-code-point chunk boundaries ---
    const marker3 = `PTYHOLDERINTEGLONG${process.pid}`;
    const filler = "x".repeat(250); // 3 chunks: 100 / 100 / 50
    const body3 = `${marker3}${filler}`;
    const cmd3 = `echo ${body3}`;
    log(`test 3: planInject — long body spanning multiple chunk boundaries`);
    await runPlanAsync(pty, planInject(cmd3, true));
    await waitFor(() => output.includes(body3), 8000, `marker3 long body echoed back intact`);
    log(`PASS test 3: long multi-chunk body arrived intact (no truncation/reorder)`);
  } catch (err) {
    failures++;
    log(`FAIL: ${err && err.message ? err.message : err}`);
  } finally {
    try {
      pty.write("exit\r");
    } catch {
      /* ignore */
    }
    await wait(300);
    try {
      pty.kill();
    } catch {
      /* ignore */
    }
  }

  log(`done. exited=${exited} exitInfo=${JSON.stringify(exitInfo)} failures=${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`[test-integration] uncaught: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
