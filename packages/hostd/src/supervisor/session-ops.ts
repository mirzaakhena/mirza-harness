import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { CLEAR_BARRIER_TIMEOUT_MS } from "./injection";
import type { EnqueueResult, InjectSource } from "./injection";

/**
 * session-ops — Task S2, Fase 2. The session-management API layer that sits
 * on top of S1's `BotSupervisor`/`InjectionQueue`: `/new`, `/switch`,
 * `/rename`, `/delete` (soft+hard), `/effort`, and the session-list picker
 * feed meta-commands.ts (mirza-marketplace) used to serve straight off the
 * filesystem (pending/*.json drops + session-names.json/archived-sessions.json
 * registries — recon-meta.md §A/§B).
 *
 * Everything that touches the PTY goes through the ONE injection path S1
 * already built (`supervisor.enqueueSlash`/`clearSession`) — this module
 * NEVER writes a pending file and NEVER spawns its own PTY. Two kinds of
 * state that are NOT pty-controlled stay here instead, per the brief:
 *   - the `sessions` table (schema.ts) — already written by H1's SessionStart
 *     hook (rpc-handlers.ts's `handleSessionStarted`); session-ops reads it
 *     for `currentSession`/name-lookup and writes `name` only AFTER an
 *     injection's ack (see `renameSession`'s docstring) — never optimistically.
 *   - the new `session_archive` table (schema.ts, this task) — a straight
 *     port of `plugins/telegram/archive-store.ts`'s archived-sessions.json
 *     to a table (brief: "port archive-store ke tabel atau file setara").
 *     Archiving/hard-delete are plugin-side bookkeeping, not pty control.
 *
 * jsonl enumeration (`listSessions`) is READING Claude Code's own on-disk
 * session history (`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`) — this is
 * historical data (including pre-migration sessions H1's hook never saw), not
 * a control channel, so reading it directly (no supervisor involved) matches
 * the brief's explicit carve-out ("BOLEH baca filesystem CC — itu histori
 * sesi, bukan kontrol").
 *
 * Kode acuan (read-only, mirza-marketplace): `plugins/telegram/sessions-list.ts`
 * (enumeration + `deriveShortId`/`encodeProjectDir`/`formatRelative`),
 * `archive-store.ts`, `session-name-rules.ts`, `session-names-registry.ts`,
 * `meta-commands.ts` (per-command flow — recon-meta.md §A/§B/§C/§D).
 */

// ---------------------------------------------------------------------------
// Bot shape — structurally compatible with config.ts's BotConfig, but kept
// minimal here so tests don't need the full zod-parsed shape.
// ---------------------------------------------------------------------------

export interface SessionOpsBot {
  id: string;
  workspace: string;
}

// ---------------------------------------------------------------------------
// Supervisor dependency — the slice of BotSupervisor session-ops actually
// needs. `queue` exposes ONLY the two read-only observability methods
// InjectionQueue already had public (`list`/`deadLetterList`) — used to
// detect an enqueued item's completion (ack vs. dead-letter) without S1's
// injection.ts needing any change (no per-item ack callback exists there).
// ---------------------------------------------------------------------------

export interface SessionOpsSupervisor {
  enqueueSlash(command: string, source?: InjectSource): EnqueueResult;
  /** S1's existing `/clear` helper — sets `sessions.lifecycle='resetting'` + enqueues `/clear`. */
  clearSession(): EnqueueResult;
  status(): { holder: string };
  queue: {
    list(): readonly { id: string }[];
    deadLetterList(): readonly { id: string }[];
  };
}

// ---------------------------------------------------------------------------
// fs seam — overridable in tests ("fake fs utk listSessions" per the brief).
// ---------------------------------------------------------------------------

export interface SessionOpsFs {
  readdirSync(dir: string): string[];
  statSync(path: string): { mtimeMs: number };
  existsSync(path: string): boolean;
  rmSync(path: string): void;
}

const realFs: SessionOpsFs = {
  readdirSync: dir => readdirSync(dir),
  statSync: path => statSync(path),
  existsSync: path => existsSync(path),
  rmSync: path => rmSync(path),
};

export interface SessionOpsDeps {
  db: Database;
  /** bot_id -> supervisor (the map `startSupervisors(...)` already returns). */
  supervisors: ReadonlyMap<string, SessionOpsSupervisor>;
  /** Base dir for CC's per-project jsonl history. Default `~/.claude/projects`. */
  claudeProjectsDir?: string;
  fs?: SessionOpsFs;
  now?: () => number;
  /** Poll interval while awaiting an injection's ack. Default 50ms. */
  ackPollMs?: number;
  /**
   * Give up waiting for a non-`/clear` injection's ack after this long
   * (`rename`, `resume`, `setEffort` go through `awaitAck` too, but only
   * `rename` currently awaits it — see `rename`). This is a fast, keystroke-
   * speed ack; the holder either accepts the slash command almost
   * immediately or something is actually wrong. Default 30_000ms.
   *
   * Deliberately NOT reused for `clearSession` — see `clearAckTimeoutMs`.
   */
  ackTimeoutMs?: number;
  /**
   * I-1 fix (task-S2-report.md "Fix pass 1"): `clearSession`'s ack is S1's
   * barrier resolving via a fresh `SessionStart` — CC startup + MCP-connect
   * routinely takes longer than a keystroke-ack, and S1's own barrier is
   * deliberately allowed up to `CLEAR_BARRIER_TIMEOUT_MS` (120_000ms) before
   * its OWN safety-release fires. Reusing the 30_000ms `ackTimeoutMs` here
   * made `/new` report a false `{ok:false, "timeout ... 30000ms"}` well
   * before S1's barrier had even had a chance to resolve normally on a slow
   * (but healthy) startup. Default: `CLEAR_BARRIER_TIMEOUT_MS + 15_000`
   * (135_000ms) — a margin so this timeout fires strictly AFTER S1's barrier
   * would have already force-released (at which point `awaitAck` sees the
   * item leave `queue.list()` for a genuine reason — ack or dead-letter —
   * well before this deadline in the common case).
   */
  clearAckTimeoutMs?: number;
  /** Injectable sleep — tests supply a synchronous/fake one. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type OpResult = { ok: true } | { ok: false; reason: string };
export type RenameResult = { ok: true; from: string; to: string } | { ok: false; reason: string };
export type ClearSessionResult = { ok: true; nameApplied: boolean } | { ok: false; reason: string };

export interface BulkResult {
  processed: number;
  skipped: number;
  errors: number;
}

export interface CurrentSessionInfo {
  id: string;
  name: string;
  lifecycle: string;
  started_at: number;
}

export interface SessionListEntry {
  /** Full UUID — the `<sid>` `/resume <sid>` (and jsonl filename) expects. */
  sessionId: string;
  /** 8-hex short id (SCAR-052) — `sessionId.replace(/-/g,'').slice(0,8)`. */
  shortId: string;
  /** Custom name from the `sessions` table, or `null` if never (re)named. */
  name: string | null;
  /** Display label: custom name (disambiguated) or a "session <hex> · <age>" fallback. */
  label: string;
  /** jsonl file mtime, ms — newest-first sort key. */
  mtime: number;
  /** True if archived (soft-deleted) via `archiveSession`. */
  archived: boolean;
  /** True if this session ever reached H1's SessionStart hook (has a `sessions` row). */
  hasDbRow: boolean;
}

// ---------------------------------------------------------------------------
// Ported pure helpers (mirza-marketplace `sessions-list.ts` — read-only kode
// acuan; logic copied, not imported — cross-repo import isn't available).
// ---------------------------------------------------------------------------

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirror of how Claude Code encodes a project path for `~/.claude/projects/`. */
export function encodeProjectDir(projectDir: string): string {
  return projectDir.replace(/[\\/:]/g, "-");
}

/** SCAR-052: short, Telegram-callback-safe id derived from a session UUID. */
export function deriveShortId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

export const SHORT_ID_RE = /^[0-9a-f]{8}$/;

/** Compact relative-age formatter for picker/list labels — see kode acuan's docstring for the exact thresholds. */
export function formatRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (delta < minute) return "just now";
  if (delta < hour) return `${Math.floor(delta / minute)}m`;
  if (delta < day) return `${Math.floor(delta / hour)}h`;
  if (delta < 14 * day) return `${Math.floor(delta / day)}d`;
  if (delta < 12 * week) return `${Math.floor(delta / week)}w`;
  const d = new Date(ts);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

// ---------------------------------------------------------------------------
// Session-name validation — port of `session-name-rules.ts`'s `validateSessionName`
// (CRLF collapse + trim, reject empty/whitespace, cap 64 chars).
// ---------------------------------------------------------------------------

export type NameValidation = { ok: true; name: string } | { ok: false; reason: string };

export function validateSessionName(rawName: string): NameValidation {
  const sanitised = rawName.replace(/[\r\n]+/g, " ").trim();
  if (sanitised.length === 0) {
    return { ok: false, reason: "nama sesi tidak boleh kosong" };
  }
  if (/\s/.test(sanitised)) {
    return { ok: false, reason: "nama sesi tidak boleh mengandung spasi — pakai tanda hubung, mis. discuss-mcp" };
  }
  return { ok: true, name: sanitised.slice(0, 64) };
}

// ---------------------------------------------------------------------------
// EFFORT_LEVELS — kode acuan's `EFFORT_LEVELS` (meta-commands.ts).
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// ---------------------------------------------------------------------------
// createSessionOps
// ---------------------------------------------------------------------------

export interface SessionOps {
  listSessions(bot: SessionOpsBot): SessionListEntry[];
  currentSession(bot: SessionOpsBot): CurrentSessionInfo | null;
  isAlive(bot: SessionOpsBot): boolean;
  resume(bot: SessionOpsBot, sessionId: string): OpResult;
  rename(bot: SessionOpsBot, name: string): Promise<RenameResult>;
  clearSession(bot: SessionOpsBot, opts?: { name?: string }): Promise<ClearSessionResult>;
  setEffort(bot: SessionOpsBot, level: string): OpResult;
  archiveSession(bot: SessionOpsBot, sessionId: string): OpResult;
  hardDelete(bot: SessionOpsBot, sessionId: string): OpResult;
  bulkArchive(bot: SessionOpsBot, exceptCurrent?: boolean): BulkResult;
  bulkDelete(bot: SessionOpsBot, exceptCurrent?: boolean): BulkResult;
}

export function createSessionOps(deps: SessionOpsDeps): SessionOps {
  const fs = deps.fs ?? realFs;
  const claudeProjectsDir = deps.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const nowFn = deps.now ?? Date.now;
  const ackPollMs = deps.ackPollMs ?? 50;
  const ackTimeoutMs = deps.ackTimeoutMs ?? 30_000;
  const clearAckTimeoutMs = deps.clearAckTimeoutMs ?? CLEAR_BARRIER_TIMEOUT_MS + 15_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  function getSupervisor(bot: SessionOpsBot): SessionOpsSupervisor | null {
    return deps.supervisors.get(bot.id) ?? null;
  }

  // -- listSessions --------------------------------------------------------

  function listSessionFiles(bot: SessionOpsBot): Array<{ sessionId: string; mtime: number }> {
    const dir = join(claudeProjectsDir, encodeProjectDir(bot.workspace));
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<{ sessionId: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.slice(0, -".jsonl".length);
      if (!SESSION_UUID_RE.test(sessionId)) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(join(dir, entry)).mtimeMs;
      } catch {
        /* skip mtime — still list the session, sorts last */
      }
      out.push({ sessionId, mtime });
    }
    return out;
  }

  function loadArchivedSet(botId: string): Set<string> {
    const rows = deps.db.query(`SELECT session_id FROM session_archive WHERE bot_id = ?`).all(botId) as {
      session_id: string;
    }[];
    return new Set(rows.map(r => r.session_id));
  }

  function loadDbNames(botId: string): Map<string, string> {
    const rows = deps.db.query(`SELECT id, name FROM sessions WHERE bot_id = ?`).all(botId) as {
      id: string;
      name: string;
    }[];
    return new Map(rows.map(r => [r.id, r.name]));
  }

  /**
   * Enumerate every session this bot's workspace has jsonl history for
   * (pre-migration history included), joined with `sessions.name` (H1's
   * SessionStart writes) and `session_archive`. Does NOT filter archived
   * entries out — callers (pickers, bulk*) that want "visible only" filter
   * on `.archived` themselves; `bulkDelete` deliberately wants archived
   * entries included so hard-delete can clean them up too.
   */
  function listSessions(bot: SessionOpsBot): SessionListEntry[] {
    const files = listSessionFiles(bot);
    if (files.length === 0) return [];

    const archived = loadArchivedSet(bot.id);
    const dbNames = loadDbNames(bot.id);
    const now = nowFn();

    const entries: SessionListEntry[] = files.map(({ sessionId, mtime }) => {
      const dbName = dbNames.get(sessionId);
      const hasDbRow = dbNames.has(sessionId);
      const name = dbName && dbName !== "idle" ? dbName : null;
      const shortId = deriveShortId(sessionId);
      const label = name ?? `session ${shortId} · ${formatRelative(mtime, now)}`;
      return { sessionId, shortId, name, label, mtime, archived: archived.has(sessionId), hasDbRow };
    });

    // Disambiguator pass — mirrors kode acuan: two sessions resolving to the
    // same custom name (legacy duplicate) get their shortId suffixed.
    const nameCounts = new Map<string, number>();
    for (const e of entries) if (e.name !== null) nameCounts.set(e.label, (nameCounts.get(e.label) ?? 0) + 1);
    for (const e of entries) {
      if (e.name !== null && (nameCounts.get(e.label) ?? 0) > 1) e.label = `${e.label} (${e.shortId})`;
    }

    entries.sort((a, b) => b.mtime - a.mtime);
    return entries;
  }

  // -- currentSession / isAlive --------------------------------------------

  function currentSession(bot: SessionOpsBot): CurrentSessionInfo | null {
    const row = deps.db
      .query(
        `SELECT id, name, lifecycle, started_at FROM sessions WHERE bot_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(bot.id) as CurrentSessionInfo | null;
    return row ?? null;
  }

  function isAlive(bot: SessionOpsBot): boolean {
    return getSupervisor(bot)?.status().holder === "running";
  }

  // -- uniqueness check ------------------------------------------------------

  function isNameTaken(bot: SessionOpsBot, name: string, exceptSessionId?: string): boolean {
    const lower = name.toLowerCase();
    return listSessions(bot).some(
      e => e.sessionId !== exceptSessionId && e.name !== null && e.name.toLowerCase() === lower,
    );
  }

  // -- ack-wait helper -------------------------------------------------------

  /**
   * Poll `supervisor.queue` (both public, pre-existing InjectionQueue
   * methods — no injection.ts change needed) until the enqueued item `id`
   * has left the active list. Distinguishes a genuine ack (item just
   * disappears) from a dead-lettered failure (item shows up in
   * `deadLetterList()`), and from a timeout (neither, after `timeoutMs`).
   *
   * `timeoutMs` is caller-supplied (I-1 fix) rather than a single shared
   * constant: `rename` wants a fast, keystroke-speed deadline
   * (`ackTimeoutMs`), `clearSession` needs one that comfortably outlives
   * S1's own `CLEAR_BARRIER_TIMEOUT_MS` (`clearAckTimeoutMs`) — see the
   * `SessionOpsDeps` docstrings.
   *
   * write-after-timeout note (I-1): once this function returns a timeout
   * result, it stops polling for good — it is a single sequential
   * `for(;;)` loop, not a background poller, so there is no later tick that
   * could still resolve `id` and trigger a write after the caller
   * (`rename`/`clearSession`) has already returned `{ok:false}` to ITS
   * caller. The `sessions.name` write in both callers happens synchronously
   * right after `await awaitAck(...)` — if that await resolves to
   * `{ok:false}` (timeout OR dead-letter), the caller returns immediately
   * without reaching the write. There is no ghost-write path to close here;
   * this comment documents that invariant per the brief's request to verify
   * it explicitly.
   */
  async function awaitAck(supervisor: SessionOpsSupervisor, id: string, timeoutMs: number): Promise<OpResult> {
    const deadline = nowFn() + timeoutMs;
    for (;;) {
      const stillPending = supervisor.queue.list().some(i => i.id === id);
      if (!stillPending) {
        const failed = supervisor.queue.deadLetterList().some(i => i.id === id);
        return failed ? { ok: false, reason: "injeksi gagal (dead-lettered oleh antrean S1)" } : { ok: true };
      }
      if (nowFn() >= deadline) return { ok: false, reason: `timeout menunggu ack (${timeoutMs}ms)` };
      await sleep(ackPollMs);
    }
  }

  // -- resume ----------------------------------------------------------------

  function resume(bot: SessionOpsBot, sessionId: string): OpResult {
    if (!SESSION_UUID_RE.test(sessionId)) {
      return { ok: false, reason: `sessionId tidak valid (harus UUID sesi Claude Code): ${JSON.stringify(sessionId)}` };
    }
    const supervisor = getSupervisor(bot);
    if (!supervisor) return { ok: false, reason: `tidak ada supervisor terdaftar utk bot "${bot.id}"` };
    const r = supervisor.enqueueSlash(`/resume ${sessionId}`, "ai");
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
  }

  // -- rename ------------------------------------------------------------

  /**
   * Renames the bot's CURRENT session. Unlike the ported source (which
   * mirrored its registry optimistically, same tick as issuing the pending
   * write — recon-meta.md §A/§B), this writes `sessions.name` only AFTER
   * the `/rename` injection is genuinely ack'd by the holder (S1's real ack
   * semantic makes that possible, where the old fire-and-forget file-drop
   * couldn't).
   */
  async function rename(bot: SessionOpsBot, rawName: string): Promise<RenameResult> {
    const supervisor = getSupervisor(bot);
    if (!supervisor) return { ok: false, reason: `tidak ada supervisor terdaftar utk bot "${bot.id}"` };

    const current = currentSession(bot);
    if (!current) return { ok: false, reason: "tidak ada sesi aktif utk bot ini (belum ada SessionStart)" };

    const validation = validateSessionName(rawName);
    if (!validation.ok) return { ok: false, reason: validation.reason };
    const name = validation.name;

    if (isNameTaken(bot, name, current.id)) {
      return { ok: false, reason: `nama "${name}" sudah dipakai sesi lain` };
    }

    const enq = supervisor.enqueueSlash(`/rename ${name}`, "ai");
    if (!enq.ok) return { ok: false, reason: enq.error };

    const ack = await awaitAck(supervisor, enq.id, ackTimeoutMs);
    if (!ack.ok) return { ok: false, reason: ack.reason };

    deps.db.run(`UPDATE sessions SET name = ? WHERE id = ?`, [name, current.id]);
    return { ok: true, from: current.name, to: name };
  }

  // -- clearSession --------------------------------------------------------

  /**
   * `/new <name>` equivalent: enqueue `/clear` (S1's `clearSession()` — sets
   * `lifecycle='resetting'`), wait for the barrier to genuinely resolve via
   * a fresh `SessionStart` (not its safety-timeout), THEN apply the
   * requested name to the row that started — detected by snapshotting the
   * pre-clear current session and checking its id/started_at actually
   * changed (a barrier-timeout release leaves the same stale row in place,
   * and must NOT have a name silently applied to the wrong session).
   */
  async function clearSession(bot: SessionOpsBot, opts: { name?: string } = {}): Promise<ClearSessionResult> {
    const supervisor = getSupervisor(bot);
    if (!supervisor) return { ok: false, reason: `tidak ada supervisor terdaftar utk bot "${bot.id}"` };

    let name: string | undefined;
    if (opts.name !== undefined) {
      const validation = validateSessionName(opts.name);
      if (!validation.ok) return { ok: false, reason: validation.reason };
      name = validation.name;
      if (isNameTaken(bot, name)) return { ok: false, reason: `nama "${name}" sudah dipakai sesi lain` };
    }

    const before = currentSession(bot);

    const enq = supervisor.clearSession();
    if (!enq.ok) return { ok: false, reason: enq.error };

    // I-1 fix: use clearAckTimeoutMs (>= CLEAR_BARRIER_TIMEOUT_MS + margin),
    // NOT the fast rename-oriented ackTimeoutMs — a healthy CC
    // startup/MCP-connect can legitimately take well over 30s.
    const ack = await awaitAck(supervisor, enq.id, clearAckTimeoutMs);
    if (!ack.ok) return { ok: false, reason: ack.reason };

    if (name === undefined) return { ok: true, nameApplied: false };

    const after = currentSession(bot);
    const freshStart = after !== null && (before === null || after.id !== before.id || after.started_at > before.started_at);
    if (!freshStart) {
      return {
        ok: false,
        reason: "barrier /clear selesai tanpa SessionStart baru terkonfirmasi (kemungkinan barrier timeout) — nama TIDAK diterapkan",
      };
    }

    deps.db.run(`UPDATE sessions SET name = ? WHERE id = ?`, [name, after!.id]);
    return { ok: true, nameApplied: true };
  }

  // -- setEffort -------------------------------------------------------------

  function setEffort(bot: SessionOpsBot, level: string): OpResult {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      return { ok: false, reason: `level effort tidak dikenal: ${JSON.stringify(level)} (harus salah satu dari ${EFFORT_LEVELS.join(", ")})` };
    }
    const supervisor = getSupervisor(bot);
    if (!supervisor) return { ok: false, reason: `tidak ada supervisor terdaftar utk bot "${bot.id}"` };
    // source:'supervisor' — the marker `guardSlashCommand` (injection.ts)
    // requires for `/effort` to pass at all (SCAR-035); AI/bus callers using
    // the default 'ai' source are blocked there, unaffected by this call.
    const r = supervisor.enqueueSlash(`/effort ${level}`, "supervisor");
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
  }

  // -- archive / hard delete -------------------------------------------------

  function archiveSession(bot: SessionOpsBot, sessionId: string): OpResult {
    deps.db.run(
      `INSERT INTO session_archive (bot_id, session_id, archived_at) VALUES (?, ?, ?)
       ON CONFLICT(bot_id, session_id) DO NOTHING`,
      [bot.id, sessionId, Math.floor(nowFn() / 1000)],
    );
    return { ok: true };
  }

  function hardDelete(bot: SessionOpsBot, sessionId: string): OpResult {
    // Race tap<->confirm: re-check current right before deleting — never
    // hard-delete the session that is (by now) actually the active one.
    const current = currentSession(bot);
    if (current && current.id === sessionId) {
      return { ok: false, reason: "tidak bisa hard-delete sesi yang sedang aktif" };
    }

    const jsonlPath = join(claudeProjectsDir, encodeProjectDir(bot.workspace), `${sessionId}.jsonl`);
    try {
      if (fs.existsSync(jsonlPath)) fs.rmSync(jsonlPath);
    } catch (err) {
      return { ok: false, reason: `gagal hapus jsonl: ${(err as Error).message}` };
    }

    deps.db.run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
    deps.db.run(`DELETE FROM session_archive WHERE bot_id = ? AND session_id = ?`, [bot.id, sessionId]);
    return { ok: true };
  }

  // -- bulk --------------------------------------------------------------

  // I-2 fix (task-S2-report.md "Fix pass 1"): `archiveSession`'s db.run (no
  // try/catch) and `hardDelete`'s two db.run DELETEs (only the rmSync is
  // wrapped) are allowed to throw for their SINGLE-item callers (caller gets
  // the exception directly, per the brief — left unchanged below). But
  // `bulkArchive`/`bulkDelete` loop over every session in one call, and the
  // `BulkResult` contract is "count each item's outcome, then keep going" —
  // an uncaught throw from item N used to abort the whole loop, silently
  // dropping items N+1..last (they'd report neither processed nor errors).
  // Each iteration is now individually try/caught so one bad item is
  // counted in `errors` and the rest of the batch still runs.

  function bulkArchive(bot: SessionOpsBot, exceptCurrent = true): BulkResult {
    const current = exceptCurrent ? currentSession(bot) : null;
    const result: BulkResult = { processed: 0, skipped: 0, errors: 0 };
    for (const s of listSessions(bot)) {
      if (current && s.sessionId === current.id) {
        result.skipped += 1;
        continue;
      }
      try {
        const r = archiveSession(bot, s.sessionId);
        if (r.ok) result.processed += 1;
        else result.errors += 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  function bulkDelete(bot: SessionOpsBot, exceptCurrent = true): BulkResult {
    const current = exceptCurrent ? currentSession(bot) : null;
    const result: BulkResult = { processed: 0, skipped: 0, errors: 0 };
    for (const s of listSessions(bot)) {
      if (current && s.sessionId === current.id) {
        result.skipped += 1;
        continue;
      }
      try {
        const r = hardDelete(bot, s.sessionId);
        if (r.ok) result.processed += 1;
        else result.errors += 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  return {
    listSessions,
    currentSession,
    isAlive,
    resume,
    rename,
    clearSession,
    setEffort,
    archiveSession,
    hardDelete,
    bulkArchive,
    bulkDelete,
  };
}
