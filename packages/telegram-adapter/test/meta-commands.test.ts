import { describe, test, expect, beforeEach } from "bun:test";
import {
  tryRouteMetaCommand,
  tryHandleMetaCallback,
  parseEffortInput,
  EFFORT_LEVELS,
  __resetSwitchPickerForTests,
  __resetDeletePickerForTests,
  __resetArchivePickerForTests,
  __resetArchiveAllForTests,
  __resetDeleteAllForTests,
  type MetaCommandBot,
  type SessionOpsClient,
  type SessionListEntry,
  type CurrentSessionInfo,
  type OpResult,
  type RenameResult,
  type ClearSessionResult,
  type BulkResult,
} from "../src/meta-commands";

// ---------------------------------------------------------------------------
// Fake SessionOpsClient — records every call, simulates hostd's session-ops
// behavior just enough for these tests (name uniqueness, current session,
// aliveness, bulk except-current filtering).
// ---------------------------------------------------------------------------

interface CallRecord {
  method: string;
  args: unknown[];
}

function fakeSession(id: string, opts: Partial<SessionListEntry> = {}): SessionListEntry {
  return {
    sessionId: id,
    shortId: id.replace(/-/g, "").slice(0, 8).toLowerCase(),
    name: opts.name ?? null,
    label: opts.label ?? (opts.name ?? `session ${id.slice(0, 8)}`),
    mtime: opts.mtime ?? 0,
    archived: opts.archived ?? false,
    hasDbRow: opts.hasDbRow ?? true,
  };
}

function makeFakeClient(initial: { alive?: boolean; sessions?: SessionListEntry[]; current?: CurrentSessionInfo | null } = {}) {
  const calls: CallRecord[] = [];
  let alive = initial.alive ?? true;
  let sessions = initial.sessions ?? [];
  let current: CurrentSessionInfo | null = initial.current ?? null;
  const takenNames = new Set<string>();

  const client: SessionOpsClient = {
    async listSessions(_bot: MetaCommandBot) {
      calls.push({ method: "listSessions", args: [] });
      return sessions;
    },
    async currentSession(_bot: MetaCommandBot) {
      calls.push({ method: "currentSession", args: [] });
      return current;
    },
    async isAlive(_bot: MetaCommandBot) {
      calls.push({ method: "isAlive", args: [] });
      return alive;
    },
    async resume(_bot: MetaCommandBot, sessionId: string): Promise<OpResult> {
      calls.push({ method: "resume", args: [sessionId] });
      return { ok: true };
    },
    async rename(_bot: MetaCommandBot, name: string): Promise<RenameResult> {
      calls.push({ method: "rename", args: [name] });
      if (/\s/.test(name)) return { ok: false, reason: "nama sesi tidak boleh mengandung spasi" };
      if (takenNames.has(name.toLowerCase())) return { ok: false, reason: `nama "${name}" sudah dipakai sesi lain` };
      const from = current?.name ?? "idle";
      if (current) current = { ...current, name };
      return { ok: true, from, to: name };
    },
    async clearSession(_bot: MetaCommandBot, opts?: { name?: string }): Promise<ClearSessionResult> {
      calls.push({ method: "clearSession", args: [opts] });
      if (opts?.name && takenNames.has(opts.name.toLowerCase())) {
        return { ok: false, reason: `nama "${opts.name}" sudah dipakai sesi lain` };
      }
      return { ok: true, nameApplied: opts?.name !== undefined };
    },
    async setEffort(_bot: MetaCommandBot, level: string): Promise<OpResult> {
      calls.push({ method: "setEffort", args: [level] });
      return { ok: true };
    },
    async archiveSession(_bot: MetaCommandBot, sessionId: string): Promise<OpResult> {
      calls.push({ method: "archiveSession", args: [sessionId] });
      return { ok: true };
    },
    async hardDelete(_bot: MetaCommandBot, sessionId: string): Promise<OpResult> {
      calls.push({ method: "hardDelete", args: [sessionId] });
      return { ok: true };
    },
    async bulkArchive(_bot: MetaCommandBot, exceptCurrent?: boolean): Promise<BulkResult> {
      calls.push({ method: "bulkArchive", args: [exceptCurrent] });
      return { processed: sessions.filter(s => !current || s.sessionId !== current.id).length, skipped: 0, errors: 0 };
    },
    async bulkDelete(_bot: MetaCommandBot, exceptCurrent?: boolean): Promise<BulkResult> {
      calls.push({ method: "bulkDelete", args: [exceptCurrent] });
      return { processed: sessions.filter(s => !current || s.sessionId !== current.id).length, skipped: 0, errors: 0 };
    },
  };

  return {
    client,
    calls,
    setSessions: (s: SessionListEntry[]) => { sessions = s; },
    setCurrent: (c: CurrentSessionInfo | null) => { current = c; },
    setAlive: (a: boolean) => { alive = a; },
    markNameTaken: (n: string) => takenNames.add(n.toLowerCase()),
  };
}

const bot: MetaCommandBot = { id: "bot-01", workspace: "/proj" };

function currentInfo(id: string, name = "idle"): CurrentSessionInfo {
  return { id, name, lifecycle: "active", started_at: 1 };
}

beforeEach(() => {
  __resetSwitchPickerForTests();
  __resetDeletePickerForTests();
  __resetArchivePickerForTests();
  __resetArchiveAllForTests();
  __resetDeleteAllForTests();
});

// ---------------------------------------------------------------------------
// parseEffortInput — ported portable pure tests (recon-meta.md §E).
// ---------------------------------------------------------------------------

describe("parseEffortInput (portable)", () => {
  test("exposes the six valid effort levels", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);
  });

  test('"/effort" alone -> picker request', () => {
    expect(parseEffortInput("/effort")).toEqual({ kind: "picker" });
  });

  test("trailing whitespace after /effort -> picker request", () => {
    expect(parseEffortInput("/effort   ")).toEqual({ kind: "picker" });
  });

  test("/effort <valid> -> direct apply with normalised level", () => {
    expect(parseEffortInput("/effort low")).toEqual({ kind: "direct", level: "low" });
    expect(parseEffortInput("/effort  HIGH  ")).toEqual({ kind: "direct", level: "high" });
    expect(parseEffortInput("/effort\tauto")).toEqual({ kind: "direct", level: "auto" });
  });

  test("/effort <invalid> -> invalid", () => {
    expect(parseEffortInput("/effort sometimes")).toEqual({ kind: "invalid", token: "sometimes" });
    expect(parseEffortInput("/effort 5")).toEqual({ kind: "invalid", token: "5" });
  });

  test("newline/CR in arg is stripped before validation", () => {
    expect(parseEffortInput("/effort low\n")).toEqual({ kind: "direct", level: "low" });
    expect(parseEffortInput("/effort\nhigh")).toEqual({ kind: "direct", level: "high" });
  });
});

// ---------------------------------------------------------------------------
// Routing order (recon-meta.md §A): bulk variants must win over the picker
// variants of /delete.
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand: routing order", () => {
  test("/delete hard all -> bulk hard-delete confirm (not the single picker)", async () => {
    const fc = makeFakeClient({ sessions: [fakeSession("a1111111-1111-1111-1111-111111111111")] });
    const r = await tryRouteMetaCommand("/delete hard all", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    if (r?.type === "meta-picker") {
      expect(r.text).toMatch(/PERMANENT/i);
      expect(r.buttons.flat().some(b => b.callbackData === "meta:delete_all_confirm")).toBe(true);
    }
  });

  test("/delete all -> bulk archive confirm (not the single picker)", async () => {
    const fc = makeFakeClient({ sessions: [fakeSession("a1111111-1111-1111-1111-111111111111")] });
    const r = await tryRouteMetaCommand("/delete all", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    if (r?.type === "meta-picker") {
      expect(r.buttons.flat().some(b => b.callbackData === "meta:archive_all_confirm")).toBe(true);
    }
  });

  test("/delete (soft) -> single-session archive picker, uses 📦 headline", async () => {
    const fc = makeFakeClient({ sessions: [fakeSession("a1111111-1111-1111-1111-111111111111")] });
    const r = await tryRouteMetaCommand("/delete", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    if (r?.type === "meta-picker") expect(r.text.startsWith("📦")).toBe(true);
  });

  test("/delete hard (single) -> hard-delete picker, uses 🗑️ headline", async () => {
    const fc = makeFakeClient({ sessions: [fakeSession("a1111111-1111-1111-1111-111111111111")] });
    const r = await tryRouteMetaCommand("/delete hard", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    if (r?.type === "meta-picker") expect(r.text.startsWith("🗑️")).toBe(true);
  });

  test("unrelated text returns null (not a meta-command)", async () => {
    const fc = makeFakeClient();
    expect(await tryRouteMetaCommand("hello world", bot, fc.client)).toBeNull();
  });

  test("'/new-onboarding' is NOT treated as /new (exact-match only)", async () => {
    const fc = makeFakeClient();
    expect(await tryRouteMetaCommand("/new-onboarding", bot, fc.client)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /new
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand: /new", () => {
  test("valid name -> SessionOps.clearSession called with that name", async () => {
    const fc = makeFakeClient();
    const r = await tryRouteMetaCommand("/new discuss-mcp", bot, fc.client);
    expect(r?.type).toBe("meta-executed");
    const call = fc.calls.find(c => c.method === "clearSession");
    expect(call?.args[0]).toEqual({ name: "discuss-mcp" });
  });

  test("no name -> usage reply, clearSession NOT called", async () => {
    const fc = makeFakeClient();
    const r = await tryRouteMetaCommand("/new", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    expect(fc.calls.some(c => c.method === "clearSession")).toBe(false);
  });

  test("bot not alive -> meta-reply, clearSession NOT called", async () => {
    const fc = makeFakeClient({ alive: false });
    const r = await tryRouteMetaCommand("/new discuss-mcp", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    expect(fc.calls.some(c => c.method === "clearSession")).toBe(false);
  });

  test("name already used -> rejected with reason relayed", async () => {
    const fc = makeFakeClient();
    fc.markNameTaken("discuss-mcp");
    const r = await tryRouteMetaCommand("/new discuss-mcp", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    if (r?.type === "meta-reply") expect(r.text).toMatch(/sudah dipakai/);
  });
});

// ---------------------------------------------------------------------------
// /rename
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand: /rename", () => {
  test("valid new name -> SessionOps.rename called, result reported", async () => {
    const fc = makeFakeClient({ current: currentInfo("s1", "old-name") });
    const r = await tryRouteMetaCommand("/rename new-name", bot, fc.client);
    expect(r?.type).toBe("meta-executed");
    if (r?.type === "meta-executed") expect(r.text).toContain('"old-name"');
    const call = fc.calls.find(c => c.method === "rename");
    expect(call?.args[0]).toBe("new-name");
  });

  test("no arg -> usage reply, rename NOT called", async () => {
    const fc = makeFakeClient();
    const r = await tryRouteMetaCommand("/rename", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    expect(fc.calls.some(c => c.method === "rename")).toBe(false);
  });

  test("name taken -> tolak (rejected), reason relayed", async () => {
    const fc = makeFakeClient({ current: currentInfo("s1") });
    fc.markNameTaken("omar");
    const r = await tryRouteMetaCommand("/rename omar", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    if (r?.type === "meta-reply") expect(r.text).toMatch(/sudah dipakai/);
  });
});

// ---------------------------------------------------------------------------
// /switch -> picker -> tap -> resume
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand + tryHandleMetaCallback: /switch", () => {
  test("/switch renders a picker excluding current, tap resolves via SessionOps.resume", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const sidB = "bbbbbbbb-1111-1111-1111-111111111111";
    const fc = makeFakeClient({
      sessions: [fakeSession(sidA, { name: "main" }), fakeSession(sidB, { name: "other" })],
      current: currentInfo(sidA, "main"),
    });

    const picked = await tryRouteMetaCommand("/switch", bot, fc.client);
    expect(picked?.type).toBe("meta-picker");
    const shortIdB = sidB.replace(/-/g, "").slice(0, 8);
    if (picked?.type === "meta-picker") {
      const callbacks = picked.buttons.flat().map(b => b.callbackData);
      expect(callbacks).toContain(`meta:switch_${shortIdB}`);
      expect(callbacks).not.toContain(`meta:switch_${sidA.replace(/-/g, "").slice(0, 8)}`);
    }

    const effects = await tryHandleMetaCallback(`meta:switch_${shortIdB}`, bot, fc.client);
    expect(effects).not.toBeNull();
    const resumeCall = fc.calls.find(c => c.method === "resume");
    expect(resumeCall?.args[0]).toBe(sidB);
  });

  test("0 other sessions -> informational reply, no picker", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const fc = makeFakeClient({ sessions: [fakeSession(sidA)], current: currentInfo(sidA) });
    const r = await tryRouteMetaCommand("/switch", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
  });
});

// ---------------------------------------------------------------------------
// /delete (soft) -> picker -> confirm -> archiveSession
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand + tryHandleMetaCallback: /delete (soft)", () => {
  test("tap then confirm calls SessionOps.archiveSession with the picked session", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const sidB = "bbbbbbbb-1111-1111-1111-111111111111";
    const fc = makeFakeClient({
      sessions: [fakeSession(sidA, { name: "main" }), fakeSession(sidB, { name: "other" })],
      current: currentInfo(sidA),
    });

    await tryRouteMetaCommand("/delete", bot, fc.client);
    const shortIdB = sidB.replace(/-/g, "").slice(0, 8);

    const tapEffects = await tryHandleMetaCallback(`meta:archive_${shortIdB}`, bot, fc.client);
    expect(tapEffects).not.toBeNull();
    const confirmPrompt = tapEffects!.find(e => e.kind === "reply");
    expect(confirmPrompt).toBeDefined();
    expect(fc.calls.some(c => c.method === "archiveSession")).toBe(false); // not yet — only tapped

    const confirmEffects = await tryHandleMetaCallback(`meta:archive_confirm_${shortIdB}`, bot, fc.client);
    const archiveCall = fc.calls.find(c => c.method === "archiveSession");
    expect(archiveCall?.args[0]).toBe(sidB);
    expect(confirmEffects!.some(e => e.kind === "edit" && e.text.includes("archived"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /delete hard all -> confirm -> bulkDelete exceptCurrent
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand + tryHandleMetaCallback: /delete hard all", () => {
  test("confirm calls SessionOps.bulkDelete(bot, true)", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const sidB = "bbbbbbbb-1111-1111-1111-111111111111";
    const fc = makeFakeClient({
      sessions: [fakeSession(sidA), fakeSession(sidB)],
      current: currentInfo(sidA),
    });

    const prompt = await tryRouteMetaCommand("/delete hard all", bot, fc.client);
    expect(prompt?.type).toBe("meta-picker");

    const effects = await tryHandleMetaCallback("meta:delete_all_confirm", bot, fc.client);
    const bulkCall = fc.calls.find(c => c.method === "bulkDelete");
    expect(bulkCall?.args).toEqual([true]);
    expect(effects!.some(e => e.kind === "edit" && e.text.includes("permanently deleted"))).toBe(true);
  });

  test("expired snapshot (no prior command) -> clear expired message, bulkDelete NOT called", async () => {
    const fc = makeFakeClient();
    const effects = await tryHandleMetaCallback("meta:delete_all_confirm", bot, fc.client);
    expect(effects!.some(e => e.kind === "ack" && /expired/i.test(e.text ?? ""))).toBe(true);
    expect(fc.calls.some(c => c.method === "bulkDelete")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// /effort high -> setEffort
// ---------------------------------------------------------------------------

describe("tryRouteMetaCommand: /effort high", () => {
  test("calls SessionOps.setEffort(bot, 'high')", async () => {
    const fc = makeFakeClient();
    const r = await tryRouteMetaCommand("/effort high", bot, fc.client);
    expect(r?.type).toBe("meta-executed");
    const call = fc.calls.find(c => c.method === "setEffort");
    expect(call?.args[0]).toBe("high");
  });

  test("bot not alive -> meta-reply, setEffort NOT called", async () => {
    const fc = makeFakeClient({ alive: false });
    const r = await tryRouteMetaCommand("/effort high", bot, fc.client);
    expect(r?.type).toBe("meta-reply");
    expect(fc.calls.some(c => c.method === "setEffort")).toBe(false);
  });

  test("/effort alone -> picker (no SessionOps call)", async () => {
    const fc = makeFakeClient();
    const r = await tryRouteMetaCommand("/effort", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    expect(fc.calls.length).toBe(0);
  });

  test("meta:effort_high callback also calls setEffort", async () => {
    const fc = makeFakeClient();
    const effects = await tryHandleMetaCallback("meta:effort_high", bot, fc.client);
    const call = fc.calls.find(c => c.method === "setEffort");
    expect(call?.args[0]).toBe("high");
    expect(effects!.some(e => e.kind === "edit" && e.text.includes("high"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Picker expired (SCAR-051): in-memory state lost -> clear message.
// ---------------------------------------------------------------------------

describe("picker expired state", () => {
  test("switch tap on unknown shortId -> clear expired message", async () => {
    const fc = makeFakeClient();
    __resetSwitchPickerForTests();
    const effects = await tryHandleMetaCallback("meta:switch_deadbeef", bot, fc.client);
    expect(effects).not.toBeNull();
    expect(effects!.some(e => e.kind === "edit" && /expired/i.test(e.text))).toBe(true);
    expect(fc.calls.some(c => c.method === "resume")).toBe(false);
  });

  test("archive confirm on unknown shortId -> prompt expired message", async () => {
    const fc = makeFakeClient();
    __resetArchivePickerForTests();
    const effects = await tryHandleMetaCallback("meta:archive_confirm_deadbeef", bot, fc.client);
    expect(effects!.some(e => e.kind === "edit" && /expired/i.test(e.text))).toBe(true);
    expect(fc.calls.some(c => c.method === "archiveSession")).toBe(false);
  });

  test("delete page callback with no picker state -> expired message", async () => {
    const fc = makeFakeClient();
    __resetDeletePickerForTests();
    const effects = await tryHandleMetaCallback("meta:delete_page_2", bot, fc.client);
    expect(effects!.some(e => e.kind === "edit" && /expired/i.test(e.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pagination — 9 sessions -> page 1 shows 6 + nav, page 2 reachable.
// ---------------------------------------------------------------------------

describe("pagination", () => {
  function seedN(n: number): SessionListEntry[] {
    const out: SessionListEntry[] = [];
    for (let i = 0; i < n; i++) {
      out.push(fakeSession(`${"a".repeat(7)}${i.toString(16)}-1111-2222-3333-444444444444`));
    }
    return out;
  }

  test("/switch with 9 sessions -> page 1 has 6 rows + nav + cancel", async () => {
    const fc = makeFakeClient({ sessions: seedN(9) });
    const r = await tryRouteMetaCommand("/switch", bot, fc.client);
    expect(r?.type).toBe("meta-picker");
    if (r?.type === "meta-picker") {
      expect(r.buttons.length).toBe(8); // 6 sessions + nav + cancel
      expect(r.buttons[6]!.map(b => b.callbackData)).toEqual(["meta:switch_page_noop", "meta:switch_page_2"]);
    }
  });

  test("meta:switch_page_2 re-renders via an edit effect", async () => {
    const fc = makeFakeClient({ sessions: seedN(9) });
    await tryRouteMetaCommand("/switch", bot, fc.client);
    const effects = await tryHandleMetaCallback("meta:switch_page_2", bot, fc.client);
    const edit = effects!.find(e => e.kind === "edit");
    expect(edit).toBeDefined();
    if (edit?.kind === "edit") {
      expect(edit.buttons!.length).toBe(5); // 3 sessions on page 2 + nav + cancel
    }
  });

  test("tap on a page-2 session still resolves (picker holds all sessions)", async () => {
    const sessions = seedN(9);
    const fc = makeFakeClient({ sessions });
    await tryRouteMetaCommand("/switch", bot, fc.client);
    const lastShort = sessions[8]!.sessionId.replace(/-/g, "").slice(0, 8);
    const effects = await tryHandleMetaCallback(`meta:switch_${lastShort}`, bot, fc.client);
    expect(effects).not.toBeNull();
    expect(fc.calls.some(c => c.method === "resume" && c.args[0] === sessions[8]!.sessionId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bulk archive (/delete all -> confirm -> bulkArchive exceptCurrent)
// ---------------------------------------------------------------------------

describe("/delete all -> confirm -> bulkArchive exceptCurrent", () => {
  test("confirm calls SessionOps.bulkArchive(bot, true)", async () => {
    const sidA = "aaaaaaaa-1111-1111-1111-111111111111";
    const fc = makeFakeClient({ sessions: [fakeSession(sidA), fakeSession("bbbbbbbb-1111-1111-1111-111111111111")], current: currentInfo(sidA) });
    await tryRouteMetaCommand("/delete all", bot, fc.client);
    const effects = await tryHandleMetaCallback("meta:archive_all_confirm", bot, fc.client);
    const call = fc.calls.find(c => c.method === "bulkArchive");
    expect(call?.args).toEqual([true]);
    expect(effects!.some(e => e.kind === "edit" && e.text.includes("archived"))).toBe(true);
  });
});
