/**
 * Task M2, Fase 2 — `/context` and `/version` reply rendering.
 *
 * Kode acuan (mirza-marketplace, read-only): `plugins/telegram/context-renderer.ts`
 * (the OLD renderer, which dereferenced `status.payload.context_window`
 * WITHOUT a null guard — FUNC-1, "TypeError: null is not an object" on a
 * statusLine snapshot that hadn't captured yet, swallowed by the bot's
 * catch-all so the user got no reply at all) and
 * `plugins/telegram/current-session-info.ts` (resolving "which session is
 * this bot on right now", ported here as hostd's `agent.status` RPC instead
 * of reading `wrapper.current_session_id`/a jsonl-backed registry — INFRA-5:
 * `agent_status` and `/context` now read the exact same `sessions` row, so
 * they can never disagree).
 *
 * Both render functions are pure (no I/O) and take already-resolved data;
 * the `SessionQuery`/`VersionQuery` interfaces below are the ONLY seam for
 * I/O, injected by the caller — production wires them to hostd RPC / package
 * .json reads (see `createRpcSessionQuery`/`createPackageJsonVersionQuery`),
 * tests inject a fake. This mirrors `context-bridge.ts`'s `ReportTelemetryDeps`
 * / `session-start.ts`'s `SessionStartDeps` injectable-`call` pattern.
 */
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// /context
// ---------------------------------------------------------------------------

/**
 * Shape of the `sessions` row `/context` needs — matches hostd's
 * `AgentStatusSessionRow` (rpc-handlers.ts) field-for-field, including the
 * Task M2 telemetry columns. All telemetry fields are nullable: NULL means
 * "no statusLine snapshot has fired yet for this session" (FUNC-1's fix —
 * a real, renderable state, never a crash).
 */
export interface SessionSnapshot {
  id: string;
  name: string;
  lifecycle: string;
  started_at: number;
  ended_at: number | null;
  used_percentage: number | null;
  context_window_size: number | null;
  model: string | null;
  effort: string | null;
  cost: number | null;
  captured_at_ms: number | null;
}

export interface SessionQuery {
  /** Resolve `botId`'s current/most-recent session row, or `null` if none exists yet. */
  getSession(botId: string): Promise<SessionSnapshot | null>;
}

/** `⏺⏺⏺⏺⏺⏺⏺⏺⏺⏺` style progress bar — ported from context-renderer.ts's `progressBar`. */
export function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct * width) / 100)));
  return "●".repeat(filled) + "○".repeat(width - filled);
}

/** Ported from context-renderer.ts's `formatRelativeMs`. */
export function formatRelativeMs(ageMs: number): string {
  if (ageMs < 0) return "just now";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm ? `${hr}h ${rm}m ago` : `${hr}h ago`;
}

/** Ported from context-renderer.ts's `shortSession`. */
export function shortSession(id: string): string {
  return id.slice(0, 8);
}

/**
 * Renders the `/context` reply from an already-resolved session row.
 *
 * FUNC-1 fix, made structural rather than a bolt-on guard: there is no
 * `payload` to dereference here at all — `session` is either `null` (no
 * `sessions` row yet — e.g. SessionStart hasn't fired once for this bot) or
 * a fully-typed `SessionSnapshot` whose telemetry fields are individually
 * nullable. Both cases render "(no data yet)" for whichever piece is
 * missing, and NEITHER case can throw a null-dereference.
 */
export function renderContextReply(session: SessionSnapshot | null, nowMs: number = Date.now()): string {
  if (!session) {
    return "(no data yet)";
  }

  const sections: string[] = [];

  // --- Context section ---
  const ctxLines: string[] = ["Context"];
  if (typeof session.used_percentage === "number") {
    ctxLines.push(`${progressBar(session.used_percentage)} ${Math.round(session.used_percentage)}%`);
    if (typeof session.context_window_size === "number") {
      ctxLines.push(`window: ${session.context_window_size}`);
    }
  } else {
    ctxLines.push("(no data yet)");
  }
  sections.push(ctxLines.join("\n"));

  // --- Metadata block ---
  const meta: string[] = [];
  meta.push(session.model ? session.model : "(no data yet)");
  meta.push(`Session: ${session.name} (${shortSession(session.id)})`);
  meta.push(`Lifecycle: ${session.lifecycle}`);
  meta.push(typeof session.cost === "number" ? `Cost: $${session.cost.toFixed(2)}` : "Cost: (no data yet)");
  meta.push(session.effort ? `Effort: ${session.effort}` : "Effort: (no data yet)");
  sections.push(meta.join("\n"));

  // --- Last update ---
  if (typeof session.captured_at_ms === "number") {
    sections.push(`Last update: ${formatRelativeMs(nowMs - session.captured_at_ms)}`);
  } else {
    sections.push("Last update: (no data yet)");
  }

  return sections.join("\n\n");
}

/** Resolve `botId`'s session via `deps` and render the `/context` reply. */
export async function buildContextReply(botId: string, deps: SessionQuery, nowMs: number = Date.now()): Promise<string> {
  const session = await deps.getSession(botId);
  return renderContextReply(session, nowMs);
}

/**
 * Production `SessionQuery`: calls hostd's `agent.status` RPC (rpc-handlers
 * .ts's `handleAgentStatus`) — the SAME query `agent_status` (the MCP tool)
 * uses, per INFRA-5. `call` is `HostdClient.call`/`callHostdOnce` shaped
 * (`(method, params) => Promise<unknown>`) so either cc-stub IPC client works
 * unchanged.
 */
export function createRpcSessionQuery(call: (method: string, params?: unknown) => Promise<unknown>): SessionQuery {
  return {
    async getSession(botId: string): Promise<SessionSnapshot | null> {
      const result = (await call("agent.status", { name: botId })) as { session: SessionSnapshot | null } | null;
      return result?.session ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// /version
// ---------------------------------------------------------------------------

export interface VersionInfo {
  hostd: string | null;
  holder: string | null;
}

export interface VersionQuery {
  getVersions(): Promise<VersionInfo> | VersionInfo;
}

/** Renders the `/version` reply — VER-1: versions are always resolved dynamically, never hardcoded. */
export function renderVersionReply(versions: VersionInfo): string {
  return ["Version", `hostd: ${versions.hostd ?? "(unknown)"}`, `pty-holder: ${versions.holder ?? "(unknown)"}`].join("\n");
}

export async function buildVersionReply(deps: VersionQuery): Promise<string> {
  const versions = await deps.getVersions();
  return renderVersionReply(versions);
}

/**
 * Reads `version` out of a `package.json` file at `pkgJsonPath`. Returns
 * `null` on any failure (missing file, invalid JSON, missing/non-string
 * field) — VER-1's whole point is an honest "unknown" rather than a
 * hardcoded/stale string, never a thrown error from a `/version` reply.
 */
export function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const raw = readFileSync(pkgJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Production `VersionQuery`: reads hostd's and pty-holder's own
 * `package.json` `version` field directly off disk (VER-1's fix — "Baca
 * versi dari plugin.json/package.json saat boot", not a hardcoded string).
 * Paths are passed in explicitly rather than assumed relative to this file,
 * since the caller (wherever `/version` is ultimately wired — outside this
 * task's scope, see task brief) knows the real monorepo layout at runtime.
 */
export function createPackageJsonVersionQuery(paths: { hostdPkgJson: string; holderPkgJson: string }): VersionQuery {
  return {
    getVersions(): VersionInfo {
      return {
        hostd: readPackageVersion(paths.hostdPkgJson),
        holder: readPackageVersion(paths.holderPkgJson),
      };
    },
  };
}
