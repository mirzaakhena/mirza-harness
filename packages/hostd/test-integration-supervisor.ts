#!/usr/bin/env bun
// Manual integration smoke test for supervisor.ts — NOT part of `bun test`.
//
// Task S1 brief: "test JANGAN spawn holder Node sungguhan" for the unit
// suite (supervisor.test.ts uses a fake HolderHandle throughout), but "Satu
// test integrasi opsional (spawn holder nyata + shell echo) boleh sebagai
// script terpisah non-suite (seperti P1)". This is that script — mirrors
// pty-holder's own `test-integration.mjs` pattern (a REAL child process,
// a plain interactive shell instead of `claude`), but one layer up: it
// exercises `spawnRealHolder`/`BotSupervisor` themselves (the actual
// `node --import tsx pty-holder/src/main.ts` spawn chain + NDJSON IPC +
// graceful-shutdown race), not pty-holder's own internals (already covered
// by that package's suite).
//
// Run manually:
//   bun run packages/hostd/test-integration-supervisor.ts
//
// Overrides `CLAUDE_BIN`/`CLAUDE_ARGS` (via the bot config's
// `claude_bin`/`claude_args` fields) to a plain nested shell instead of a
// real `claude` invocation — deliberately not exercising the real Claude
// Code binary, same rationale as pty-holder's own integration script.

import { openDb } from "./src/state/db";
import { BotSupervisor, spawnRealHolder } from "./src/supervisor/supervisor";
import type { BotConfig } from "./src/config";

function log(msg: string): void {
  process.stdout.write(`[test-integration-supervisor] ${msg}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
    await wait(50);
  }
}

async function main(): Promise<void> {
  const isWindows = process.platform === "win32";
  // Nested interactive shell, NOT claude — same "plain shell" substitution
  // pty-holder's own test-integration.mjs uses. Empty claude_args -> the
  // bare shell binary with no flags, so it just sits there reading stdin.
  const bot: BotConfig = {
    id: "bot-it-s1",
    telegram_token: "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    workspace: process.cwd(),
    claude_bin: isWindows ? "cmd" : process.env.SHELL || "/bin/sh",
    claude_args: isWindows ? "" : "-i",
  };

  const db = openDb(":memory:");
  const supervisor = new BotSupervisor({ bot, db, spawnHolder: spawnRealHolder, backoffBaseMs: 60_000 });

  let failures = 0;

  try {
    log(`starting supervisor for ${bot.id} (claude_bin=${bot.claude_bin} claude_args="${bot.claude_args}")`);
    supervisor.start();

    // Give the real `node --import tsx pty-holder/src/main.ts` child (and
    // its nested node-pty shell) time to actually come up.
    await wait(1_500);
    log(`status after spawn: ${JSON.stringify(supervisor.status())}`);
    if (supervisor.status().holder !== "running") {
      throw new Error(`expected holder 'running' after spawn, got '${supervisor.status().holder}'`);
    }

    // --- Test: real inject round-trips a keystroke-level ack ------------
    // `enqueueSlash` requires a leading '/' (it's CC slash-command syntax);
    // we want to type a plain shell command into the nested shell, so use
    // the queue's `enqueueText` path instead (arbitrary text, no guard).
    const marker = `SUP_IT_${process.pid}_${Date.now()}`;
    const textResult = supervisor.queue.enqueueText(`echo ${marker}`);
    if (!textResult.ok) throw new Error(`enqueueText failed: ${textResult.error}`);
    log(`enqueued text injection (id: ${textResult.id})`);

    await waitFor(() => supervisor.status().queue === 0, 8_000, "queue drains (injected ack received)");
    log(`PASS: injection acked — queue drained, status: ${JSON.stringify(supervisor.status())}`);

    // --- Test: graceful stop() actually terminates the real child -------
    log("calling supervisor.stop() (graceful RPC shutdown + 5s OS force-kill fallback)...");
    const stopStart = Date.now();
    await supervisor.stop();
    const stopElapsedMs = Date.now() - stopStart;
    log(`PASS: stop() resolved in ${stopElapsedMs}ms, status: ${JSON.stringify(supervisor.status())}`);
    if (supervisor.status().holder !== "dead") {
      failures++;
      log(`FAIL: expected holder 'dead' after stop(), got '${supervisor.status().holder}'`);
    }
  } catch (err) {
    failures++;
    log(`FAIL: ${err instanceof Error ? err.stack ?? err.message : err}`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  log(`done. failures=${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`[test-integration-supervisor] uncaught: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
