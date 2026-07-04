import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteFile, type AtomicFsOps } from "@mirza-harness/shared";
import type { BotConfig } from "../config";

/**
 * Legacy-file shim writer — Task X1, Fase 2.
 *
 * During the mixed-fleet window, peer bots still running the OLD
 * `pty-controller` wrapper (mirza-marketplace) read a handful of plain
 * files off disk to learn a pilot bot's session identity/lifecycle,
 * liveness, and version. This module is hostd's WRITER side of that
 * contract for pilot bots: whenever hostd learns something a peer would
 * have learned from the old wrapper's own writes, it mirrors the same
 * files, in the same shape, to the same paths — see recon-hooks.md §D/§F
 * and recon-wrapper.md §A/§F (mirza-marketplace's Fase-2 recon docs) for the
 * file -> key -> consumer -> trigger table this module implements.
 *
 * Kode acuan (read-only references, mirza-marketplace):
 *  - `plugins/pty-controller/wrapper/src/session-state.ts` (`SessionState`
 *    shape, `buildNextState`'s seq-increment rule) + `wrapper.ts`'s
 *    `writeCurrentSessionId`/`writeCurrentSessionName`/`writeSystemOutbox`
 *    (lines ~161-207, ~630-652) for the per-session-change file set.
 *  - `wrapper.ts`'s heartbeat/pid/version writers (lines ~768-823).
 *  - `plugins/agent-bus/registry.ts` for the `agent-registry.json` schema
 *    and its `<path>.lock` O_EXCL locking protocol (ported below with ONE
 *    deliberate change: lock-wait is a non-blocking async retry, not
 *    `Bun.sleepSync`'s busy-wait — same rationale as `atomic-write.ts`'s
 *    docstring).
 *
 * Every file write in this module goes through `@mirza-harness/shared`'s
 * `atomicWriteFile` (tmp+rename, SCAR-022 EPERM/EBUSY retry) per the task
 * brief's "SEMUA file legacy... atomic tmp+rename retry SCAR-022".
 *
 * PENSIUN_DATE: this whole module is a bridge, not a permanent feature. Once
 * the fleet has fully migrated off the old wrapper (no more peers reading
 * these files), it should be deleted outright. `isExpired` lets hostd's
 * doctor surface a loud warning if the shim is still wired up past that
 * date, so its removal doesn't quietly get forgotten (Fase 3 follow-up).
 */

// ---------------------------------------------------------------------------
// Pensiun marker
// ---------------------------------------------------------------------------

/** This module should be deleted once the fleet no longer has any peer bot
 * reading the legacy files it writes. Chosen as a "wajar" ~2-month runway
 * past Fase-2 landing (2026-07) — not a hard deadline, just a tripwire so
 * `doctor` can nag if the shim outlives its expected lifetime. */
export const PENSIUN_DATE = new Date("2026-09-01T00:00:00.000Z");

/** True once `now` is past `PENSIUN_DATE`. Accepts a `Date`, epoch ms, or
 * (default) the real current time. */
export function isExpired(now: Date | number = Date.now()): boolean {
  const t = typeof now === "number" ? now : now.getTime();
  return t > PENSIUN_DATE.getTime();
}

// ---------------------------------------------------------------------------
// Public event payload shapes
// ---------------------------------------------------------------------------

export interface SessionChangeEvent {
  session_id: string | null;
  session_name: string | null;
  lifecycle: string;
}

export interface BootEvent {
  pid: number;
  plugin_version: string | null;
  wrapper_version: string | null;
}

/** In-memory mirror of `wrapper.state.json`'s shape (session-state.ts's
 * `SessionState`) — kept per-bot so `seq` increments monotonically across
 * calls within this process's lifetime. */
export interface WrapperState {
  session_id: string | null;
  session_name: string | null;
  lifecycle: string;
  seq: number;
  updated_at_ms: number;
}

// ---------------------------------------------------------------------------
// agent-registry.json shapes (ported from plugins/agent-bus/registry.ts)
// ---------------------------------------------------------------------------

export interface AgentRegistryEntry {
  project_dir: string;
  state_dir: string;
  registered_at: string;
  last_heartbeat: string;
  wrapper_pid: number;
}

export interface AgentRegistry {
  schema_version: 1;
  agents: Record<string, AgentRegistryEntry>;
}

// ---------------------------------------------------------------------------
// fs seam (tests inject this so nothing ever touches the real ~/.claude)
// ---------------------------------------------------------------------------

/** Superset of `AtomicFsOps` (from `@mirza-harness/shared`) plus the O_EXCL
 * lock primitives `registry.ts`'s locking protocol needs — kept as one
 * interface so a test only has to inject a single `fsOps` bag. */
export interface LegacyWriterFsOps extends AtomicFsOps {
  /** `fs.openSync(path, flag)` — used with `"wx"` for O_EXCL lock creation. */
  open: (path: string, flag: string) => number;
  close: (fd: number) => void;
}

const defaultFsOps: LegacyWriterFsOps = {
  mkdir: dir => mkdirSync(dir, { recursive: true }),
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
  unlink: path => unlinkSync(path),
  readFile: path => readFileSync(path, "utf8"),
  exists: path => existsSync(path),
  open: (path, flag) => openSync(path, flag),
  close: fd => closeSync(fd),
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface CreateLegacyWriterOptions {
  /**
   * `botId -> pty-controller state dir`
   * (`<bot.workspace>/.claude/channels/pty-controller` in production).
   * Test-injectable directly to a tmp dir — the writer never derives this
   * from `botConfig` itself, so tests don't need a real workspace on disk.
   */
  stateDirFor: (botId: string) => string;
  /**
   * Home directory housing `.claude/agent-registry.json`
   * (`os.homedir()` in production). Test-injectable to a tmp dir so tests
   * never touch the real `~/.claude`.
   */
  homeDir: string;
  /**
   * `botId -> BotConfig` resolver, consulted only for the agent-registry
   * entry (`project_dir` = `bot.workspace`; the registry key itself mirrors
   * kode acuan's `SELF_AGENT_NAME` — `basename(bot.workspace)` — so OLD
   * peer bots that key their own registry lookups off a basename keep
   * finding this pilot after migration).
   */
  botConfig: (botId: string) => BotConfig;
  /** Injectable clock (ms), default `Date.now`. */
  now?: () => number;
  /** fs seam for tests. Default: real node:fs. */
  fsOps?: Partial<LegacyWriterFsOps>;
  /** Registry lock acquisition timeout, ms. Default 2000 (matches kode acuan). */
  lockTimeoutMs?: number;
  /** Registry lock retry interval, ms. Default 25 (matches kode acuan). */
  lockRetryMs?: number;
}

export interface LegacyWriter {
  onSessionChange(botId: string, evt: SessionChangeEvent): Promise<void>;
  onHeartbeat(botId: string): Promise<void>;
  onBoot(botId: string, evt: BootEvent): Promise<void>;
  onShutdown(botId: string): Promise<void>;
  updateRegistryHeartbeat(botId: string): Promise<void>;
  /** Convenience passthrough so callers (e.g. `doctor.ts`) don't need a
   * separate import just to check the pensiun date. */
  isExpired(now?: Date | number): boolean;
}

export function createLegacyWriter(options: CreateLegacyWriterOptions): LegacyWriter {
  const fs: LegacyWriterFsOps = { ...defaultFsOps, ...options.fsOps };
  const now = options.now ?? Date.now;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  const lockRetryMs = options.lockRetryMs ?? 25;

  // seq-increment cache: seeded lazily from an on-disk wrapper.state.json
  // (if present) the first time a bot is touched, then held in-memory —
  // mirrors kode acuan's module-scoped `sessionState` variable.
  const stateCache = new Map<string, WrapperState>();

  function ptyDir(botId: string): string {
    return options.stateDirFor(botId);
  }

  // Telegram's state dir is a SIBLING of the pty-controller one (both live
  // under <workspace>/.claude/channels/), matching kode acuan's
  // TELEGRAM_STATE_DIR derivation — computed from stateDirFor's RESULT so a
  // test's tmp-dir override for `stateDirFor` still gets a coherent sibling
  // path, without this module needing bot.workspace at all.
  function telegramDir(botId: string): string {
    return join(dirname(ptyDir(botId)), "telegram");
  }

  function registryPath(): string {
    return join(options.homeDir, ".claude", "agent-registry.json");
  }

  /** Mirrors kode acuan's `SELF_AGENT_NAME = PROJECT_DIR.split(/[\/\\]/).filter(Boolean).pop() ?? 'unknown'`. */
  function registryName(cfg: BotConfig): string {
    return basename(cfg.workspace.replace(/[\\/]+$/, "")) || cfg.id;
  }

  function loadState(botId: string): WrapperState | null {
    const cached = stateCache.get(botId);
    if (cached) return cached;
    const file = join(ptyDir(botId), "wrapper.state.json");
    if (!fs.exists(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFile(file)) as Partial<WrapperState>;
      if (typeof parsed.seq === "number") {
        const seeded: WrapperState = {
          session_id: parsed.session_id ?? null,
          session_name: parsed.session_name ?? null,
          lifecycle: typeof parsed.lifecycle === "string" ? parsed.lifecycle : "unknown",
          seq: parsed.seq,
          updated_at_ms: typeof parsed.updated_at_ms === "number" ? parsed.updated_at_ms : now(),
        };
        stateCache.set(botId, seeded);
        return seeded;
      }
    } catch {
      /* corrupt/missing — treated as no prior state */
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // agent-registry.json — O_EXCL lock protocol ported from
  // plugins/agent-bus/registry.ts. Non-blocking async retry (setTimeout),
  // NOT the kode acuan busy-wait / Bun.sleepSync — see module docstring.
  // -------------------------------------------------------------------------

  async function acquireRegistryLock(path: string): Promise<() => Promise<void>> {
    const lockPath = `${path}.lock`;
    fs.mkdir(dirname(path));
    const start = now();
    for (;;) {
      try {
        const fd = fs.open(lockPath, "wx");
        fs.close(fd);
        return async () => {
          try {
            fs.unlink(lockPath);
          } catch {
            /* best-effort */
          }
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (now() - start > lockTimeoutMs) {
          throw new Error(`legacy-writer: agent-registry lock timeout after ${lockTimeoutMs}ms: ${lockPath}`);
        }
        await sleep(lockRetryMs);
      }
    }
  }

  function loadRegistry(path: string): AgentRegistry {
    if (!fs.exists(path)) return { schema_version: 1, agents: {} };
    try {
      const obj = JSON.parse(fs.readFile(path));
      if (obj && typeof obj === "object" && obj.schema_version === 1 && obj.agents) {
        return obj as AgentRegistry;
      }
    } catch {
      /* corrupt — reset */
    }
    return { schema_version: 1, agents: {} };
  }

  async function persistRegistry(path: string, reg: AgentRegistry): Promise<void> {
    await atomicWriteFile(path, JSON.stringify(reg, null, 2), { fsOps: fs });
  }

  async function withRegistryLock<T>(fn: (reg: AgentRegistry, path: string) => T | Promise<T>): Promise<T> {
    const path = registryPath();
    const release = await acquireRegistryLock(path);
    try {
      const reg = loadRegistry(path);
      const result = await fn(reg, path);
      return result;
    } finally {
      await release();
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  async function onSessionChange(botId: string, evt: SessionChangeEvent): Promise<void> {
    const dir = ptyDir(botId);
    const prev = loadState(botId);
    const state: WrapperState = {
      session_id: evt.session_id,
      session_name: evt.session_name,
      lifecycle: evt.lifecycle,
      seq: (prev?.seq ?? 0) + 1,
      updated_at_ms: now(),
    };
    stateCache.set(botId, state);

    // 1. wrapper.state.json — single source of truth, compact (no pretty
    // print — matches kode acuan's writeSessionState exactly).
    await atomicWriteFile(join(dir, "wrapper.state.json"), JSON.stringify(state), { fsOps: fs });

    // 2. wrapper.current_session_id — overwrite ONLY when a concrete id is
    // present (mirrors kode acuan's updateSessionState: a lifecycle-only /
    // name-only patch must not clobber the last known id).
    if (evt.session_id) {
      await atomicWriteFile(join(dir, "wrapper.current_session_id"), evt.session_id, { fsOps: fs });
    }

    // 3. wrapper.current_session_name — ALWAYS overwrite; empty string means
    // "no known name" (readers treat '' as null).
    await atomicWriteFile(join(dir, "wrapper.current_session_name"), evt.session_name ?? "", { fsOps: fs });

    // 4. telegram system-outbox event — camelCase keys (sessionId/sessionName),
    // deliberately NOT the same casing as wrapper.state.json's
    // session_id/session_name (kode acuan's writeSystemOutbox passes these
    // through verbatim from the wrapper's own camelCase locals).
    const outboxId = randomUUID();
    const outboxPayload = {
      id: outboxId,
      ts: new Date(now()).toISOString(),
      type: "session-change",
      sessionId: evt.session_id,
      sessionName: evt.session_name,
    };
    await atomicWriteFile(
      join(telegramDir(botId), "system-outbox", `${outboxId}.json`),
      JSON.stringify(outboxPayload, null, 2),
      { fsOps: fs },
    );
  }

  async function onHeartbeat(botId: string): Promise<void> {
    await atomicWriteFile(join(ptyDir(botId), "wrapper.heartbeat"), new Date(now()).toISOString(), { fsOps: fs });
  }

  async function onBoot(botId: string, evt: BootEvent): Promise<void> {
    const dir = ptyDir(botId);
    await atomicWriteFile(join(dir, "wrapper.pid"), String(evt.pid), { fsOps: fs });
    await atomicWriteFile(
      join(dir, "wrapper.version"),
      JSON.stringify({ plugin_version: evt.plugin_version, wrapper_version: evt.wrapper_version }, null, 2),
      { fsOps: fs },
    );

    const cfg = options.botConfig(botId);
    const name = registryName(cfg);
    await withRegistryLock(async (reg, path) => {
      const existing = reg.agents[name];
      const nowIso = new Date(now()).toISOString();
      reg.agents[name] = {
        project_dir: cfg.workspace,
        state_dir: dir,
        registered_at: existing?.registered_at ?? nowIso,
        last_heartbeat: nowIso,
        wrapper_pid: evt.pid,
      };
      await persistRegistry(path, reg);
    });
  }

  async function onShutdown(botId: string): Promise<void> {
    try {
      fs.unlink(join(ptyDir(botId), "wrapper.pid"));
    } catch {
      /* already gone is fine — matches kode acuan's swallow */
    }

    const cfg = options.botConfig(botId);
    const name = registryName(cfg);
    await withRegistryLock(async (reg, path) => {
      if (!reg.agents[name]) return;
      delete reg.agents[name];
      await persistRegistry(path, reg);
    });
  }

  async function updateRegistryHeartbeat(botId: string): Promise<void> {
    const cfg = options.botConfig(botId);
    const name = registryName(cfg);
    await withRegistryLock(async (reg, path) => {
      const e = reg.agents[name];
      if (!e) return;
      e.last_heartbeat = new Date(now()).toISOString();
      await persistRegistry(path, reg);
    });
  }

  return {
    onSessionChange,
    onHeartbeat,
    onBoot,
    onShutdown,
    updateRegistryHeartbeat,
    isExpired: (t?: Date | number) => isExpired(t ?? now()),
  };
}
