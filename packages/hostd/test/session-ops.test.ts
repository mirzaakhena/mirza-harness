import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/state/db";
import type { EnqueueResult, InjectSource } from "../src/supervisor/injection";
import {
  createSessionOps,
  deriveShortId,
  encodeProjectDir,
  validateSessionName,
  EFFORT_LEVELS,
  type SessionOpsFs,
  type SessionOpsSupervisor,
} from "../src/supervisor/session-ops";

/**
 * Task S2, Fase 2 — session-ops.ts tests. Per the brief: fake supervisor
 * (records every `enqueueSlash`/`clearSession` call, controllable ack/dead-
 * letter timing) + fake fs (in-memory jsonl directory listing) — never a
 * real pty-holder, never the real filesystem/homedir.
 */

const BOT = { id: "bot-test", workspace: "C:/ws/bot-test" };
const PROJECTS_DIR = "C:/fake/.claude/projects";
const SESSION_DIR = join(PROJECTS_DIR, encodeProjectDir(BOT.workspace));

const SID_A = "11111111-1111-1111-1111-111111111111";
const SID_B = "22222222-2222-2222-2222-222222222222";
const SID_C = "33333333-3333-3333-3333-333333333333";

// ---------------------------------------------------------------------------
// Fake fs — in-memory single-directory jsonl listing.
// ---------------------------------------------------------------------------

function makeFakeFs(initialFiles: Record<string, number>): { fs: SessionOpsFs; files: Map<string, number>; rmCalls: string[] } {
  const files = new Map<string, number>(Object.entries(initialFiles));
  const rmCalls: string[] = [];
  const fs: SessionOpsFs = {
    readdirSync(dir: string): string[] {
      if (dir !== SESSION_DIR) return [];
      return [...files.keys()];
    },
    statSync(path: string): { mtimeMs: number } {
      const filename = path.slice(SESSION_DIR.length + 1);
      const mtime = files.get(filename);
      if (mtime === undefined) throw new Error(`ENOENT: ${path}`);
      return { mtimeMs: mtime };
    },
    existsSync(path: string): boolean {
      const filename = path.slice(SESSION_DIR.length + 1);
      return files.has(filename);
    },
    rmSync(path: string): void {
      rmCalls.push(path);
      const filename = path.slice(SESSION_DIR.length + 1);
      files.delete(filename);
    },
  };
  return { fs, files, rmCalls };
}

// ---------------------------------------------------------------------------
// Fake supervisor — records calls, controllable ack/dead-letter timing via
// the injected `sleep` seam (test drives when a pending id resolves).
// ---------------------------------------------------------------------------

class FakeSupervisor implements SessionOpsSupervisor {
  readonly calls: Array<{ command: string; source?: InjectSource }> = [];
  clearCalls = 0;
  holderState: "starting" | "running" | "dead" | "restarting" = "running";
  private seq = 0;
  private readonly pending = new Set<string>();
  private readonly dead = new Set<string>();
  /** Called once per `sleep()` tick during an `awaitAck` poll — tests use this to resolve/dead-letter a pending id mid-flight. */
  onTick: (() => void) | null = null;

  enqueueSlash(command: string, source?: InjectSource): EnqueueResult {
    this.calls.push({ command, source });
    const id = `id-${this.seq++}`;
    this.pending.add(id);
    return { ok: true, id };
  }
  clearSession(): EnqueueResult {
    this.clearCalls += 1;
    const id = `clear-${this.seq++}`;
    this.pending.add(id);
    return { ok: true, id };
  }
  status(): { holder: string } {
    return { holder: this.holderState };
  }
  queue = {
    list: (): readonly { id: string }[] => [...this.pending].map(id => ({ id })),
    deadLetterList: (): readonly { id: string }[] => [...this.dead].map(id => ({ id })),
  };
  resolveAck(id: string): void {
    this.pending.delete(id);
  }
  resolveDead(id: string): void {
    this.pending.delete(id);
    this.dead.add(id);
  }
  /** Resolve whatever is currently pending (single in-flight item assumed) as acked. */
  resolveAllAck(): void {
    for (const id of [...this.pending]) this.resolveAck(id);
  }
  resolveAllDead(): void {
    for (const id of [...this.pending]) this.resolveDead(id);
  }
}

function makeSleep(sup: FakeSupervisor) {
  return async (_ms: number): Promise<void> => {
    sup.onTick?.();
  };
}

function makeOps(overrides: { db?: Database; sup?: FakeSupervisor; fakeFs?: SessionOpsFs; now?: () => number } = {}) {
  const db = overrides.db ?? openDb(":memory:");
  const sup = overrides.sup ?? new FakeSupervisor();
  const supervisors = new Map([[BOT.id, sup as SessionOpsSupervisor]]);
  const ops = createSessionOps({
    db,
    supervisors,
    claudeProjectsDir: PROJECTS_DIR,
    fs: overrides.fakeFs,
    now: overrides.now,
    ackPollMs: 1,
    sleep: makeSleep(sup),
  });
  return { db, sup, ops };
}

function insertSession(db: Database, id: string, botId: string, name: string, startedAt: number, lifecycle = "idle"): void {
  db.run(`INSERT INTO bots (id, workspace) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`, [botId, "C:/ws/" + botId]);
  db.run(
    `INSERT INTO sessions (id, bot_id, name, lifecycle, started_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, lifecycle = excluded.lifecycle`,
    [id, botId, name, lifecycle, startedAt],
  );
}

// ---------------------------------------------------------------------------
// validateSessionName — portable pure rules
// ---------------------------------------------------------------------------

describe("validateSessionName", () => {
  test("rejects empty/whitespace-only", () => {
    expect(validateSessionName("").ok).toBe(false);
    expect(validateSessionName("   ").ok).toBe(false);
  });
  test("rejects internal whitespace", () => {
    expect(validateSessionName("foo bar").ok).toBe(false);
  });
  test("collapses CRLF to space (then rejects, since that's whitespace)", () => {
    const r = validateSessionName("foo\r\nbar");
    expect(r.ok).toBe(false);
  });
  test("accepts a clean hyphenated name and truncates at 64", () => {
    const r = validateSessionName("discuss-mcp");
    expect(r).toEqual({ ok: true, name: "discuss-mcp" });
    const long = "a".repeat(100);
    const r2 = validateSessionName(long);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.name.length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("listSessions", () => {
  test("enumerates jsonl files, joins db names, flags archived, sorts newest-first", () => {
    const { fs } = makeFakeFs({
      [`${SID_A}.jsonl`]: 1000,
      [`${SID_B}.jsonl`]: 3000,
      [`${SID_C}.jsonl`]: 2000,
      "memory.md": 5000, // non-uuid — must be filtered out
    });
    const { db, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "named-session", 1000);
    ops.archiveSession(BOT, SID_C);

    const list = ops.listSessions(BOT);
    expect(list.map(e => e.sessionId)).toEqual([SID_B, SID_C, SID_A]); // mtime desc
    const a = list.find(e => e.sessionId === SID_A)!;
    expect(a.name).toBe("named-session");
    expect(a.label).toBe("named-session");
    expect(a.hasDbRow).toBe(true);
    expect(a.shortId).toBe(deriveShortId(SID_A));
    const b = list.find(e => e.sessionId === SID_B)!;
    expect(b.name).toBeNull();
    expect(b.label).toContain(b.shortId);
    expect(b.hasDbRow).toBe(false);
    const c = list.find(e => e.sessionId === SID_C)!;
    expect(c.archived).toBe(true);
    expect(b.archived).toBe(false);
  });

  test("empty dir / missing dir -> empty list", () => {
    const { fs } = makeFakeFs({});
    const { ops } = makeOps({ fakeFs: fs });
    expect(ops.listSessions(BOT)).toEqual([]);
  });

  test("'idle' db name is treated as no custom name (fallback label used)", () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000 });
    const { db, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    const [entry] = ops.listSessions(BOT);
    expect(entry!.name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// currentSession / isAlive
// ---------------------------------------------------------------------------

describe("currentSession / isAlive", () => {
  test("currentSession returns the latest-started row; null when none", () => {
    const { db, ops } = makeOps();
    expect(ops.currentSession(BOT)).toBeNull();
    insertSession(db, SID_A, BOT.id, "idle", 100);
    insertSession(db, SID_B, BOT.id, "idle", 200);
    expect(ops.currentSession(BOT)!.id).toBe(SID_B);
  });

  test("isAlive reflects supervisor.status().holder === 'running'", () => {
    const { sup, ops } = makeOps();
    expect(ops.isAlive(BOT)).toBe(true);
    sup.holderState = "dead";
    expect(ops.isAlive(BOT)).toBe(false);
  });

  test("isAlive is false when no supervisor is registered for the bot", () => {
    const db = openDb(":memory:");
    const ops = createSessionOps({ db, supervisors: new Map() });
    expect(ops.isAlive(BOT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe("resume", () => {
  test("injects /resume <sessionId> via the supervisor's queue", () => {
    const { sup, ops } = makeOps();
    const r = ops.resume(BOT, SID_A);
    expect(r).toEqual({ ok: true });
    expect(sup.calls).toEqual([{ command: `/resume ${SID_A}`, source: "ai" }]);
  });

  test("rejects a non-UUID sessionId without touching the supervisor", () => {
    const { sup, ops } = makeOps();
    const r = ops.resume(BOT, "not-a-uuid");
    expect(r.ok).toBe(false);
    expect(sup.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setEffort
// ---------------------------------------------------------------------------

describe("setEffort", () => {
  test("all levels enqueue /effort <level> with source:'supervisor' (SCAR-035 marker)", () => {
    for (const level of EFFORT_LEVELS) {
      const { sup, ops } = makeOps();
      const r = ops.setEffort(BOT, level);
      expect(r).toEqual({ ok: true });
      expect(sup.calls).toEqual([{ command: `/effort ${level}`, source: "supervisor" }]);
    }
  });

  test("rejects an unknown level without touching the supervisor", () => {
    const { sup, ops } = makeOps();
    const r = ops.setEffort(BOT, "ultra");
    expect(r.ok).toBe(false);
    expect(sup.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rename — write-after-ack semantics
// ---------------------------------------------------------------------------

describe("rename", () => {
  test("writes sessions.name only after the /rename injection acks", async () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000 });
    const { db, sup, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    sup.onTick = () => sup.resolveAllAck();

    const r = await ops.rename(BOT, "new-name");
    expect(r).toEqual({ ok: true, from: "idle", to: "new-name" });
    expect(sup.calls).toEqual([{ command: "/rename new-name", source: "ai" }]);
    const row = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_A) as { name: string };
    expect(row.name).toBe("new-name");
  });

  test("no current session -> rejected, nothing enqueued", async () => {
    const { sup, ops } = makeOps();
    const r = await ops.rename(BOT, "whatever");
    expect(r.ok).toBe(false);
    expect(sup.calls.length).toBe(0);
  });

  test("rejects a name already taken by another session (case-insensitive), except its own", async () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000, [`${SID_B}.jsonl`]: 2000 });
    const { db, sup, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "taken-name", 1000);
    insertSession(db, SID_B, BOT.id, "idle", 2000); // current (latest started_at)
    const r = await ops.rename(BOT, "Taken-Name");
    expect(r.ok).toBe(false);
    expect(sup.calls.length).toBe(0);

    // Renaming the current session to its OWN existing name is not blocked
    // by the "except itself" carve-out.
    sup.onTick = () => sup.resolveAllAck();
    insertSession(db, SID_B, BOT.id, "idle", 2000);
    const r2 = await ops.rename(BOT, "idle");
    // "idle" is not a real custom name (treated as unset) so this just renames normally.
    expect(r2.ok).toBe(true);
  });

  test("dead-lettered injection -> rename fails, db name untouched", async () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000 });
    const { db, sup, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    sup.onTick = () => sup.resolveAllDead();

    const r = await ops.rename(BOT, "new-name");
    expect(r.ok).toBe(false);
    const row = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_A) as { name: string };
    expect(row.name).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

describe("clearSession", () => {
  test("no name requested: enqueues /clear via supervisor.clearSession(), waits for ack", async () => {
    const { sup, ops } = makeOps();
    sup.onTick = () => sup.resolveAllAck();
    const r = await ops.clearSession(BOT);
    expect(r).toEqual({ ok: true, nameApplied: false });
    expect(sup.clearCalls).toBe(1);
  });

  test("name requested + genuine fresh SessionStart -> name applied to the NEW row", async () => {
    const { db, sup, ops } = makeOps();
    insertSession(db, SID_A, BOT.id, "idle", 1000); // pre-clear session
    sup.onTick = () => {
      insertSession(db, SID_B, BOT.id, "idle", 2000); // simulates the hook's SessionStart insert
      sup.resolveAllAck();
    };
    const r = await ops.clearSession(BOT, { name: "fresh-name" });
    expect(r).toEqual({ ok: true, nameApplied: true });
    const row = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_B) as { name: string };
    expect(row.name).toBe("fresh-name");
    const oldRow = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_A) as { name: string };
    expect(oldRow.name).toBe("idle"); // old row untouched
  });

  test("barrier resolves WITHOUT a fresh SessionStart (timeout case) -> name NOT applied", async () => {
    const { db, sup, ops } = makeOps();
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    sup.onTick = () => sup.resolveAllAck(); // ack fires, but no new session row appears (simulates barrier-timeout release)
    const r = await ops.clearSession(BOT, { name: "fresh-name" });
    expect(r.ok).toBe(false);
    const row = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_A) as { name: string };
    expect(row.name).toBe("idle");
  });

  test("requested name already taken by another session -> rejected before enqueueing", async () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000 });
    const { db, sup, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "taken", 1000);
    const r = await ops.clearSession(BOT, { name: "taken" });
    expect(r.ok).toBe(false);
    expect(sup.clearCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// I-1 fix — clearSession vs rename use SEPARATE ack timeouts. clearSession's
// ack is a barrier resolving via a genuine SessionStart, which (by S1's own
// design, CLEAR_BARRIER_TIMEOUT_MS) may legitimately take up to 120_000ms;
// reusing rename's fast 30_000ms default produced a false timeout on a slow
// but healthy CC startup/MCP-connect. Uses a real (non-fake) `sleep`+`now`
// pairing so the timeout math is genuinely exercised, via a fake wall clock
// driven from `onTick` (no real waiting).
// ---------------------------------------------------------------------------

describe("I-1: separate ack timeouts for clearSession vs rename", () => {
  test("clearSession: ack arrives at simulated t=100s -> succeeds (does NOT hit the 30s rename timeout)", async () => {
    let clock = 0;
    const sup = new FakeSupervisor();
    const db = openDb(":memory:");
    const supervisors = new Map([[BOT.id, sup as SessionOpsSupervisor]]);
    // Each sleep tick advances the fake clock by 10s; ack resolves on the 10th tick (t=100s).
    let ticks = 0;
    sup.onTick = () => {
      ticks += 1;
      clock += 10_000;
      if (ticks >= 10) sup.resolveAllAck();
    };
    const ops = createSessionOps({
      db,
      supervisors,
      claudeProjectsDir: PROJECTS_DIR,
      now: () => clock,
      ackPollMs: 1,
      sleep: makeSleep(sup),
      // clearAckTimeoutMs left at its default (>=120_000ms) — 100s must NOT time out.
    });
    const r = await ops.clearSession(BOT);
    expect(r).toEqual({ ok: true, nameApplied: false });
  });

  test("rename: ack arrives at simulated t=40s -> times out (rename keeps the fast 30s default)", async () => {
    let clock = 0;
    const sup = new FakeSupervisor();
    const db = openDb(":memory:");
    const supervisors = new Map([[BOT.id, sup as SessionOpsSupervisor]]);
    insertSession(db, SID_A, BOT.id, "idle", 0);
    let ticks = 0;
    sup.onTick = () => {
      ticks += 1;
      clock += 10_000;
      if (ticks >= 4) sup.resolveAllAck(); // t=40s — past the 30s rename deadline
    };
    const ops = createSessionOps({
      db,
      supervisors,
      claudeProjectsDir: PROJECTS_DIR,
      now: () => clock,
      ackPollMs: 1,
      sleep: makeSleep(sup),
    });
    const r = await ops.rename(BOT, "new-name");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("timeout");
    const row = db.query(`SELECT name FROM sessions WHERE id = ?`).get(SID_A) as { name: string };
    expect(row.name).toBe("idle"); // no ghost write after the caller already saw a timeout
  });
});

// ---------------------------------------------------------------------------
// archive / hard delete — idempotent
// ---------------------------------------------------------------------------

describe("archiveSession / hardDelete", () => {
  test("archiveSession is idempotent", () => {
    const { db, ops } = makeOps();
    expect(ops.archiveSession(BOT, SID_A)).toEqual({ ok: true });
    expect(ops.archiveSession(BOT, SID_A)).toEqual({ ok: true });
    const rows = db.query(`SELECT * FROM session_archive WHERE bot_id = ? AND session_id = ?`).all(BOT.id, SID_A);
    expect(rows.length).toBe(1);
  });

  test("hardDelete removes the jsonl file, sessions row, and archive row; idempotent on repeat", () => {
    const { fs, files } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000, [`${SID_B}.jsonl`]: 2000 });
    const { db, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    insertSession(db, SID_B, BOT.id, "idle", 2000); // current (latest started_at) — SID_A is not
    ops.archiveSession(BOT, SID_A);

    const r1 = ops.hardDelete(BOT, SID_A);
    expect(r1).toEqual({ ok: true });
    expect(files.has(`${SID_A}.jsonl`)).toBe(false);
    expect(db.query(`SELECT * FROM sessions WHERE id = ?`).get(SID_A)).toBeNull();
    expect(db.query(`SELECT * FROM session_archive WHERE session_id = ?`).get(SID_A)).toBeNull();

    // Second call: jsonl already gone, row already gone — still succeeds, no throw.
    const r2 = ops.hardDelete(BOT, SID_A);
    expect(r2).toEqual({ ok: true });
  });

  test("hardDelete refuses to delete the currently-active session (race tap<->confirm)", () => {
    const { fs } = makeFakeFs({ [`${SID_A}.jsonl`]: 1000 });
    const { db, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    const r = ops.hardDelete(BOT, SID_A);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bulk — skip current
// ---------------------------------------------------------------------------

describe("bulkArchive / bulkDelete", () => {
  function setupThree() {
    const { fs, files } = makeFakeFs({
      [`${SID_A}.jsonl`]: 1000,
      [`${SID_B}.jsonl`]: 2000,
      [`${SID_C}.jsonl`]: 3000, // newest -> current
    });
    const { db, ops } = makeOps({ fakeFs: fs });
    insertSession(db, SID_A, BOT.id, "idle", 1000);
    insertSession(db, SID_B, BOT.id, "idle", 2000);
    insertSession(db, SID_C, BOT.id, "idle", 3000);
    return { db, ops, files };
  }

  test("bulkArchive(exceptCurrent=true) skips the current session, archives the rest", () => {
    const { db, ops } = setupThree();
    const result = ops.bulkArchive(BOT, true);
    expect(result).toEqual({ processed: 2, skipped: 1, errors: 0 });
    const archivedIds = (db.query(`SELECT session_id FROM session_archive WHERE bot_id = ?`).all(BOT.id) as { session_id: string }[]).map(r => r.session_id);
    expect(new Set(archivedIds)).toEqual(new Set([SID_A, SID_B]));
  });

  test("bulkDelete(exceptCurrent=true) skips current, hard-deletes the rest", () => {
    const { db, ops, files } = setupThree();
    const result = ops.bulkDelete(BOT, true);
    expect(result).toEqual({ processed: 2, skipped: 1, errors: 0 });
    expect(files.has(`${SID_C}.jsonl`)).toBe(true); // current untouched
    expect(files.has(`${SID_A}.jsonl`)).toBe(false);
    expect(files.has(`${SID_B}.jsonl`)).toBe(false);
    expect(db.query(`SELECT * FROM sessions WHERE id = ?`).get(SID_C)).not.toBeNull();
  });

  test("exceptCurrent=false processes every session including current", () => {
    const { ops } = setupThree();
    const result = ops.bulkArchive(BOT, false);
    expect(result).toEqual({ processed: 3, skipped: 0, errors: 0 });
  });

  // -- I-2 fix: one item's db.run throw must not abort the rest of the batch --

  test("I-2: bulkArchive — one item's db.run throws mid-loop -> that item is counted in errors, the rest still get processed", () => {
    const { db, ops } = setupThree();
    const original = db.run.bind(db);
    (db as any).run = (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO session_archive") && Array.isArray(params) && params[1] === SID_A) {
        throw new Error("boom: simulated db failure for SID_A");
      }
      return original(sql, params as any);
    };
    const result = ops.bulkArchive(BOT, true); // SID_C is current -> skipped; SID_A throws; SID_B should still succeed
    expect(result).toEqual({ processed: 1, skipped: 1, errors: 1 });
    const archivedIds = (
      db.query(`SELECT session_id FROM session_archive WHERE bot_id = ?`).all(BOT.id) as { session_id: string }[]
    ).map(r => r.session_id);
    expect(archivedIds).toEqual([SID_B]);
  });

  test("I-2: bulkDelete — one item's db.run throws mid-loop -> that item is counted in errors, the rest still get processed", () => {
    const { db, ops, files } = setupThree();
    const original = db.run.bind(db);
    (db as any).run = (sql: string, params?: unknown[]) => {
      if (sql.startsWith("DELETE FROM sessions") && Array.isArray(params) && params[0] === SID_A) {
        throw new Error("boom: simulated db failure for SID_A");
      }
      return original(sql, params as any);
    };
    const result = ops.bulkDelete(BOT, true); // SID_C is current -> skipped; SID_A throws; SID_B should still be hard-deleted
    expect(result).toEqual({ processed: 1, skipped: 1, errors: 1 });
    expect(files.has(`${SID_B}.jsonl`)).toBe(false); // SID_B still processed despite SID_A's throw
    expect(db.query(`SELECT * FROM sessions WHERE id = ?`).get(SID_B)).toBeNull();
    expect(db.query(`SELECT * FROM sessions WHERE id = ?`).get(SID_C)).not.toBeNull(); // current untouched
  });
});
