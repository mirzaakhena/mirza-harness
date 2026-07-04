#!/usr/bin/env bun
/**
 * Task M2, Fase 2 — statusLine bridge: extracts telemetry from Claude Code's
 * statusLine stdin snapshot (design doc §10.5b / bot-01's masukan, CC
 * >=2.1.199: `payload.context_window.{used_percentage, context_window_size}`
 * + `payload.model`/`payload.effort`/`payload.cost`/`payload.session_id`),
 * reports it to hostd's `telemetry.report` RPC (writes the telemetry columns
 * of the matching `sessions` row — schema.ts, Task M2), then chains to
 * whatever statusLine command was configured before this bridge (recon-hooks
 * .md §E: "Sekarang: statusLine CC -> context-bridge.ts -> last-status.json
 * ... Baru: context-bridge -> RPC hostd telemetry.report -> kolom telemetri
 * baris sessions").
 *
 * Replaces `plugins/telegram/scripts/context-bridge.ts` (mirza-marketplace):
 * that script wrote a local `last-status.json` snapshot file (with a
 * deliberate `payload: null` on unparseable stdin) which `/context` read
 * directly and dereferenced without a null guard — FUNC-1. Here there is no
 * local snapshot file at all: hostd's `sessions` table (INFRA-5) is the
 * single place telemetry lives, read by BOTH `/context`
 * (telegram-adapter/src/context-command.ts) and `agent_status`
 * (hostd/src/rpc-handlers.ts's `handleAgentStatus`) — one writer, so a
 * "null vs missing" disagreement between readers can't happen. And this
 * bridge structurally can't reproduce FUNC-1: `parseStatusLineInput` below
 * returns `null` (skip the RPC call entirely) on unparseable/keyless stdin
 * instead of ever calling `telemetry.report` with a garbage/null payload.
 *
 * Fails soft end-to-end, on purpose: a Claude Code statusLine command runs on
 * every prompt/response cycle and its output becomes the visible status
 * line — it must NEVER block, delay, or corrupt that rendering. So:
 *   - unparseable/incomplete stdin -> the telemetry.report call is skipped
 *     (nothing meaningful to report), not retried, not logged loudly.
 *   - hostd unreachable/timeout/error -> the rejection is swallowed.
 *   - EITHER way, the chain to the previous statusLine command (if one was
 *     configured) always runs, and this process always exits 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";
import { resolveBotId } from "../src/tools";
import { callHostdOnce } from "../hooks/session-start";

// ---------------------------------------------------------------------------
// stdin parsing — CC's statusLine payload. Only the fields telemetry.report
// needs are read; everything else in the snapshot is ignored here (the
// renderer, context-command.ts, only ever sees what hostd persisted).
// ---------------------------------------------------------------------------

export interface TelemetryReportParams {
  bot_id: string;
  session_id: string;
  used_percentage: number | null;
  context_window_size: number | null;
  model: string | null;
  effort: string | null;
  cost: number | null;
  captured_at_ms: number;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function nonEmptyStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parse CC's statusLine stdin JSON into `telemetry.report`'s params
 * (`bot_id` filled in separately by the caller). Returns `null` when the
 * stdin isn't JSON or lacks a non-empty `session_id` — there is nothing to
 * key a `sessions` row update on without it (mirrors
 * `../hooks/session-start.ts`'s `parseSessionStartInput` "fail silent,
 * nothing worth reporting" contract — this is the FUNC-1 fix: skip the
 * report entirely rather than ever writing/reporting a null payload).
 */
export function parseStatusLineInput(
  raw: string,
  botId: string,
  nowMs: () => number = Date.now,
): TelemetryReportParams | null {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = input as Record<string, unknown> | null;
  const sessionId = obj?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;

  const contextWindow = obj?.context_window as Record<string, unknown> | undefined;
  const model = obj?.model as Record<string, unknown> | undefined;
  const effort = obj?.effort as Record<string, unknown> | undefined;
  const cost = obj?.cost as Record<string, unknown> | undefined;

  return {
    bot_id: botId,
    session_id: sessionId,
    used_percentage: numberOrNull(contextWindow?.used_percentage),
    context_window_size: numberOrNull(contextWindow?.context_window_size),
    model: nonEmptyStringOrNull(model?.display_name),
    effort: nonEmptyStringOrNull(effort?.level),
    cost: numberOrNull(cost?.total_cost_usd),
    captured_at_ms: nowMs(),
  };
}

// ---------------------------------------------------------------------------
// telemetry.report — best-effort, injectable `call` (mirrors
// ../hooks/session-start.ts's `SessionStartDeps` pattern).
// ---------------------------------------------------------------------------

export interface ReportTelemetryDeps {
  call: (method: string, params: unknown) => Promise<unknown>;
}

/**
 * Reports `params` to hostd's `telemetry.report`. NEVER throws/rejects —
 * hostd unreachable, timeout, RPC error, or a rejected/malformed reply are
 * all swallowed here so the caller can unconditionally proceed to chain +
 * exit 0 (module docstring's "fails soft end-to-end").
 */
export async function reportTelemetry(params: TelemetryReportParams, deps: ReportTelemetryDeps): Promise<void> {
  try {
    await deps.call("telemetry.report", params);
  } catch {
    // Best-effort — see module docstring. A statusLine bridge must never
    // fail loudly just because hostd is momentarily unreachable.
  }
}

// ---------------------------------------------------------------------------
// Chain to the previously-configured statusLine command (unchanged behavior
// from `plugins/telegram/scripts/context-bridge.ts`, ported).
// ---------------------------------------------------------------------------

/**
 * Resolve the `chained-statusline` file path from `CLAUDE_PROJECT_DIR` — the
 * same convention `plugins/telegram/scripts/context-bridge.ts` used
 * (`<project>/.claude/channels/telegram/chained-statusline`). Returns `null`
 * when the env var is absent/blank (nothing to chain to, and no directory to
 * even look in).
 */
export function resolveChainedStatusLineFile(env: Record<string, string | undefined>): string | null {
  const projectDir = env.CLAUDE_PROJECT_DIR?.trim();
  if (!projectDir) return null;
  return join(projectDir, ".claude", "channels", "telegram", "chained-statusline");
}

/**
 * Executes the previous statusLine command (if `chainFile` exists and isn't
 * blank), piping `stdin` into it and forwarding its stdout/stderr straight
 * through (`inherit`) — since THIS process's stdout IS what Claude Code
 * reads as the status line, chaining means "let the old command's output be
 * ours". No-op (nothing printed, nothing thrown) when `chainFile` is `null`
 * or missing/blank — that's the normal case for a bot that never had a
 * custom statusLine configured before this bridge.
 */
export function runChainedStatusLine(chainFile: string | null, stdin: string): void {
  if (!chainFile || !existsSync(chainFile)) return;
  const chain = readFileSync(chainFile, "utf8").trim();
  if (!chain) return;
  spawnSync(chain, { input: stdin, stdio: ["pipe", "inherit", "inherit"], shell: true });
}

// ---------------------------------------------------------------------------
// Entrypoint.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  const botId = resolveBotId();
  const params = parseStatusLineInput(raw, botId);
  if (params) {
    const pipeName = process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;
    await reportTelemetry(params, { call: (method, callParams) => callHostdOnce(pipeName, method, callParams) });
  }

  // ALWAYS chain, regardless of whether the telemetry report above ran,
  // succeeded, or was skipped — module docstring's "fails soft end-to-end".
  runChainedStatusLine(resolveChainedStatusLineFile(process.env), raw);
}

if (import.meta.main) {
  main()
    .catch(() => {
      // Belt-and-braces: even an unexpected throw here must not surface as a
      // non-zero exit / crash log from a statusLine command.
    })
    .finally(() => process.exit(0));
}
