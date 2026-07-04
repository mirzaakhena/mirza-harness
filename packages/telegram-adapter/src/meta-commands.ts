/**
 * Meta-command router — Task M1, Fase 2. Ports mirza-marketplace's
 * `plugins/telegram/meta-commands.ts` (routing + picker + confirm/callback
 * logic — recon-meta.md §A/§D) onto hostd's session-ops supervisor API (S2,
 * `packages/hostd/src/supervisor/session-ops.ts`) instead of filesystem
 * pending-drops + `wrapper.heartbeat`/`session-names.json`/
 * `archived-sessions.json` (recon-meta.md §B).
 *
 * Deliberately NOT importing `@mirza-harness/hostd` — telegram-adapter is a
 * leaf package, hostd depends on it, not the other way around.
 * `SessionOpsClient` below is a structural subset of hostd's `SessionOps`
 * interface; in production it is backed by an RPC call into hostd, in tests
 * by a fake (see test/meta-commands.test.ts). Every method is Promise-
 * returning to match that RPC boundary, even though some of hostd's
 * underlying `SessionOps` methods are synchronous.
 *
 * This module never sends a Telegram message itself. `tryRouteMetaCommand`
 * returns a single `MetaCommandResult` (or `null` when the text isn't a
 * recognized meta-command); `tryHandleMetaCallback` returns an ordered list
 * of `MetaCallbackEffect`s (or `null` when the callback isn't `meta:*`). The
 * caller (inbound.ts, then a later outbound-wiring task) is responsible for
 * actually sending/acking/editing — outbound delivery is out of scope here.
 *
 * Liveness gate: `SessionOps.isAlive(bot)` replaces the old
 * `wrapper.heartbeat` freshness check (recon-meta.md §B note). Picker state
 * (switch/delete/archive + the two bulk snapshots) stays in-memory,
 * process-lifetime only (SCAR-051) — a restart loses it and any stale tap
 * reports "expired" explicitly rather than silently doing nothing.
 *
 * /effort dual-policy (recon-meta.md §C): the Telegram path below always
 * calls `SessionOpsClient.setEffort`, which S2's `session-ops.ts` already
 * wires to inject with the `'supervisor'` source marker (bypassing the
 * AI-path slash-guard) — this module does not need to know about
 * `confirmAfterMs`, S2 owns that.
 */

import { renderPickerPage } from "./paginated-picker";

// ---------------------------------------------------------------------------
// Bot identity — structurally compatible with hostd's `SessionOpsBot`.
// ---------------------------------------------------------------------------

export interface MetaCommandBot {
  id: string;
  workspace: string;
}

// ---------------------------------------------------------------------------
// Structural mirrors of hostd's session-ops.ts result/entry shapes. Not
// imported (wrong dependency direction) — copied so this module has no
// compile-time dependency on `@mirza-harness/hostd`.
// ---------------------------------------------------------------------------

export interface SessionListEntry {
  sessionId: string;
  shortId: string;
  name: string | null;
  label: string;
  mtime: number;
  archived: boolean;
  hasDbRow: boolean;
}

export interface CurrentSessionInfo {
  id: string;
  name: string;
  lifecycle: string;
  started_at: number;
}

export type OpResult = { ok: true } | { ok: false; reason: string };
export type RenameResult = { ok: true; from: string; to: string } | { ok: false; reason: string };
export type ClearSessionResult = { ok: true; nameApplied: boolean } | { ok: false; reason: string };

export interface BulkResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * The slice of hostd's `SessionOps` this router needs. Production
 * implementation is an RPC client to hostd; tests supply a fake. All async
 * to match the RPC boundary.
 */
export interface SessionOpsClient {
  listSessions(bot: MetaCommandBot): Promise<SessionListEntry[]>;
  currentSession(bot: MetaCommandBot): Promise<CurrentSessionInfo | null>;
  isAlive(bot: MetaCommandBot): Promise<boolean>;
  resume(bot: MetaCommandBot, sessionId: string): Promise<OpResult>;
  rename(bot: MetaCommandBot, name: string): Promise<RenameResult>;
  clearSession(bot: MetaCommandBot, opts?: { name?: string }): Promise<ClearSessionResult>;
  setEffort(bot: MetaCommandBot, level: string): Promise<OpResult>;
  archiveSession(bot: MetaCommandBot, sessionId: string): Promise<OpResult>;
  hardDelete(bot: MetaCommandBot, sessionId: string): Promise<OpResult>;
  bulkArchive(bot: MetaCommandBot, exceptCurrent?: boolean): Promise<BulkResult>;
  bulkDelete(bot: MetaCommandBot, exceptCurrent?: boolean): Promise<BulkResult>;
}

// ---------------------------------------------------------------------------
// /effort parsing — ported unchanged (pure) from mirza-marketplace's
// meta-commands.ts (recon-meta.md §E: "portable murni").
// ---------------------------------------------------------------------------

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export type EffortInput =
  | { kind: "picker" }
  | { kind: "direct"; level: EffortLevel }
  | { kind: "invalid"; token: string };

/**
 * Parse a raw "/effort ..." Telegram input. Whitespace is collapsed,
 * embedded CR/LF stripped, the level is lowercased. Assumes the input
 * already matched the "/effort" prefix in the router.
 */
export function parseEffortInput(text: string): EffortInput {
  const stripped = text.replace(/[\r\n]+/g, " ");
  const lower = stripped.toLowerCase().trim();
  if (lower === "/effort") return { kind: "picker" };
  if (!lower.startsWith("/effort ") && !lower.startsWith("/effort\t")) {
    return { kind: "invalid", token: lower };
  }
  const rest = stripped.slice("/effort".length).trim().toLowerCase();
  if (rest.length === 0) return { kind: "picker" };
  if ((EFFORT_LEVELS as readonly string[]).includes(rest)) {
    return { kind: "direct", level: rest as EffortLevel };
  }
  return { kind: "invalid", token: rest };
}

// ---------------------------------------------------------------------------
// Picker rendering (pure) — recon-meta.md §D: MAX 6/page, shortId 8-hex.
// ---------------------------------------------------------------------------

export const SHORT_ID_RE = /^[0-9a-f]{8}$/;

export interface MetaCommandButton {
  label: string;
  callbackData: string;
}

// ---------------------------------------------------------------------------
// Output shapes — the caller (inbound.ts, later outbound wiring) sends
// these; this module never sends anything itself.
// ---------------------------------------------------------------------------

export type MetaCommandResult =
  | { type: "meta-reply"; text: string; buttons?: MetaCommandButton[][] }
  | { type: "meta-picker"; text: string; buttons: MetaCommandButton[][] }
  | { type: "meta-executed"; text: string; buttons?: MetaCommandButton[][] };

export type MetaCallbackEffect =
  /** Transient toast above the chat (Telegram's answerCallbackQuery). */
  | { kind: "ack"; text?: string }
  /** Edit the message that carried the tapped button (strips/replaces its keyboard). */
  | { kind: "edit"; text: string; buttons?: MetaCommandButton[][] }
  /** Send a brand-new message (e.g. a confirm/cancel follow-up prompt). */
  | { kind: "reply"; result: MetaCommandResult };

function metaReply(text: string, buttons?: MetaCommandButton[][]): MetaCommandResult {
  return { type: "meta-reply", text, buttons };
}
function metaPicker(text: string, buttons: MetaCommandButton[][]): MetaCommandResult {
  return { type: "meta-picker", text, buttons };
}
function metaExecuted(text: string, buttons?: MetaCommandButton[][]): MetaCommandResult {
  return { type: "meta-executed", text, buttons };
}

// ---------------------------------------------------------------------------
// In-memory picker state (SCAR-051) — process-lifetime only. A restart (or
// the __reset*ForTests helpers) wipes these; any stale tap reports
// "expired" explicitly rather than acting on garbage.
// ---------------------------------------------------------------------------

interface PickerEntry {
  sessionId: string;
  label: string;
  shortId: string;
}

const switchPicker = new Map<string, PickerEntry>();
let switchPickerSessions: PickerEntry[] = [];

const deletePicker = new Map<string, PickerEntry>();
let deletePickerSessions: PickerEntry[] = [];

const archivePicker = new Map<string, PickerEntry>();
let archivePickerSessions: PickerEntry[] = [];

let archiveAllSessions: PickerEntry[] = [];
let deleteAllSessions: PickerEntry[] = [];

function toPickerEntry(s: SessionListEntry): PickerEntry {
  return { sessionId: s.sessionId, label: s.label, shortId: s.shortId };
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

async function listOtherVisibleSessions(
  bot: MetaCommandBot,
  client: SessionOpsClient,
): Promise<{ sessions: SessionListEntry[]; currentId: string | null }> {
  const [all, current] = await Promise.all([client.listSessions(bot), client.currentSession(bot)]);
  const currentId = current?.id ?? null;
  return { sessions: all.filter(s => !s.archived && s.sessionId !== currentId), currentId };
}

function pageNote(page: number, totalPages: number): string {
  return totalPages > 1 ? ` (page ${page}/${totalPages})` : "";
}
function switchHeadline(currentLabel: string | null, page: number, totalPages: number): string {
  return currentLabel
    ? `🔀 Pick a session to switch to (currently on "${currentLabel}")${pageNote(page, totalPages)}:`
    : `🔀 Pick a session to switch to${pageNote(page, totalPages)}:`;
}
function deleteHeadline(page: number, totalPages: number): string {
  return `🗑️ Pick a session to delete${pageNote(page, totalPages)}:`;
}
function archiveHeadline(page: number, totalPages: number): string {
  return `📦 Pick a session to archive${pageNote(page, totalPages)}:`;
}

// ---------------------------------------------------------------------------
// tryRouteMetaCommand — text command router.
// ---------------------------------------------------------------------------

/**
 * Try to handle `text` as a Telegram meta-command. Returns:
 *   - a `MetaCommandResult` → consumed (caller must NOT forward to AI)
 *   - `null`                 → not a meta-command (caller continues normal flow)
 *
 * Match order (recon-meta.md §A): bulk variants of /delete MUST be checked
 * before the single-session picker variants — "/delete hard all" would
 * otherwise be swallowed by the "/delete hard " picker check.
 */
export async function tryRouteMetaCommand(
  text: string,
  bot: MetaCommandBot,
  client: SessionOpsClient,
): Promise<MetaCommandResult | null> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === "/new" || lower.startsWith("/new ") || lower.startsWith("/new\t")) {
    return handleNew(bot, client, trimmed.slice("/new".length).trim());
  }
  if (lower === "/switch") {
    return handleSwitch(bot, client);
  }
  if (lower === "/delete hard all" || lower.startsWith("/delete hard all ")) {
    return handleDeleteAll(bot, client);
  }
  if (lower === "/delete all" || lower.startsWith("/delete all ")) {
    return handleArchiveAll(bot, client);
  }
  if (lower === "/delete" || lower === "/delete " || lower.startsWith("/delete  ")) {
    return handleArchive(bot, client);
  }
  if (lower === "/delete hard" || lower.startsWith("/delete hard ")) {
    return handleDelete(bot, client);
  }
  if (lower === "/rename" || lower.startsWith("/rename ") || lower.startsWith("/rename\t")) {
    return handleRename(bot, client, trimmed.slice("/rename".length).trim());
  }
  if (lower === "/effort" || lower.startsWith("/effort ") || lower.startsWith("/effort\t")) {
    const parsed = parseEffortInput(trimmed);
    if (parsed.kind === "picker") return handleEffortPicker();
    if (parsed.kind === "invalid") {
      return metaReply(`⚠️ /effort needs one of: ${EFFORT_LEVELS.join(", ")}`);
    }
    return handleEffortDirect(bot, client, parsed.level);
  }
  return null;
}

async function handleNew(bot: MetaCommandBot, client: SessionOpsClient, rawName: string): Promise<MetaCommandResult> {
  if (rawName.length === 0) {
    return metaReply("⚠️ /new needs a session name, e.g. /new discuss-mcp");
  }
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /new cannot run: bot session is not alive.");
  }
  const result = await client.clearSession(bot, { name: rawName });
  if (!result.ok) return metaReply(`⚠️ /new failed: ${result.reason}`);
  return metaExecuted(
    result.nameApplied ? `🧹 New session started as "${rawName}".` : "🧹 New session started.",
  );
}

async function handleRename(bot: MetaCommandBot, client: SessionOpsClient, rawName: string): Promise<MetaCommandResult> {
  if (rawName.length === 0) {
    return metaReply("⚠️ /rename needs a new name, e.g. /rename discuss-mcp");
  }
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /rename cannot run: bot session is not alive.");
  }
  const result = await client.rename(bot, rawName);
  if (!result.ok) return metaReply(`⚠️ /rename failed: ${result.reason}`);
  const fromLabel = result.from && result.from !== "idle" ? result.from : null;
  return metaExecuted(
    fromLabel
      ? `✏️ Renamed session from "${fromLabel}" to "${result.to}".`
      : `✏️ Renamed session to "${result.to}".`,
  );
}

async function handleEffortDirect(
  bot: MetaCommandBot,
  client: SessionOpsClient,
  level: EffortLevel,
): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /effort cannot run: bot session is not alive.");
  }
  const result = await client.setEffort(bot, level);
  if (!result.ok) return metaReply(`⚠️ /effort failed: ${result.reason}`);
  return metaExecuted(`🎯 Effort: ${level}`);
}

async function handleEffortPicker(): Promise<MetaCommandResult> {
  const rows: MetaCommandButton[][] = [
    [
      { label: "low", callbackData: "meta:effort_low" },
      { label: "medium", callbackData: "meta:effort_medium" },
    ],
    [
      { label: "high", callbackData: "meta:effort_high" },
      { label: "xhigh", callbackData: "meta:effort_xhigh" },
    ],
    [
      { label: "max", callbackData: "meta:effort_max" },
      { label: "auto", callbackData: "meta:effort_auto" },
    ],
    [{ label: "❌ Cancel", callbackData: "meta:effort_cancel" }],
  ];
  return metaPicker("🎯 Pick an effort level for this session", rows);
}

async function handleSwitch(bot: MetaCommandBot, client: SessionOpsClient): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /switch cannot run: bot session is not alive.");
  }
  const all = await client.listSessions(bot);
  const current = await client.currentSession(bot);
  const currentId = current?.id ?? null;
  const currentEntry = currentId ? all.find(s => s.sessionId === currentId) : undefined;
  const currentLabel = currentEntry?.label ?? (currentId ? `session ${currentId.slice(0, 8)}` : null);
  const sessions = all.filter(s => !s.archived && s.sessionId !== currentId);

  if (sessions.length === 0) {
    return metaReply(
      currentLabel
        ? `Only one session in this project ("${currentLabel}"). No other session to switch to.`
        : "No sessions in this project.",
    );
  }

  switchPicker.clear();
  switchPickerSessions = sessions.map(toPickerEntry);
  for (const s of switchPickerSessions) switchPicker.set(s.shortId, s);

  const { rows, currentPage, totalPages } = renderPickerPage({
    sessions: switchPickerSessions,
    page: 1,
    callbackPrefix: "meta:switch",
    cancelCallback: "meta:cancel",
    labelOf: s => s.label,
    sessionCallbackOf: s => `meta:switch_${s.shortId}`,
  });
  return metaPicker(switchHeadline(currentLabel, currentPage, totalPages), rows);
}

async function handleArchive(bot: MetaCommandBot, client: SessionOpsClient): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /delete cannot run: bot session is not alive.");
  }
  const { sessions } = await listOtherVisibleSessions(bot, client);
  if (sessions.length === 0) return metaReply("No other sessions available to archive.");

  archivePicker.clear();
  archivePickerSessions = sessions.map(toPickerEntry);
  for (const s of archivePickerSessions) archivePicker.set(s.shortId, s);

  const { rows, currentPage, totalPages } = renderPickerPage({
    sessions: archivePickerSessions,
    page: 1,
    callbackPrefix: "meta:archive",
    cancelCallback: "meta:archive_cancel",
    labelOf: s => s.label,
    sessionCallbackOf: s => `meta:archive_${s.shortId}`,
  });
  return metaPicker(archiveHeadline(currentPage, totalPages), rows);
}

async function handleDelete(bot: MetaCommandBot, client: SessionOpsClient): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /delete cannot run: bot session is not alive.");
  }
  const { sessions } = await listOtherVisibleSessions(bot, client);
  if (sessions.length === 0) return metaReply("No other sessions available to delete.");

  deletePicker.clear();
  deletePickerSessions = sessions.map(toPickerEntry);
  for (const s of deletePickerSessions) deletePicker.set(s.shortId, s);

  const { rows, currentPage, totalPages } = renderPickerPage({
    sessions: deletePickerSessions,
    page: 1,
    callbackPrefix: "meta:delete",
    cancelCallback: "meta:delete_cancel",
    labelOf: s => s.label,
    sessionCallbackOf: s => `meta:delete_${s.shortId}`,
  });
  return metaPicker(deleteHeadline(currentPage, totalPages), rows);
}

async function handleArchiveAll(bot: MetaCommandBot, client: SessionOpsClient): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /delete all cannot run: bot session is not alive.");
  }
  const { sessions } = await listOtherVisibleSessions(bot, client);
  if (sessions.length === 0) return metaReply("No other sessions to archive.");

  archiveAllSessions = sessions.map(toPickerEntry);
  return metaPicker(`📦 Archive all ${sessions.length} sessions (except the active one)?`, [
    [
      { label: `✅ Archive ${sessions.length} sessions`, callbackData: "meta:archive_all_confirm" },
      { label: "❌ Cancel", callbackData: "meta:archive_all_cancel" },
    ],
  ]);
}

async function handleDeleteAll(bot: MetaCommandBot, client: SessionOpsClient): Promise<MetaCommandResult> {
  if (!(await client.isAlive(bot))) {
    return metaReply("⚠️ /delete hard all cannot run: bot session is not alive.");
  }
  const { sessions } = await listOtherVisibleSessions(bot, client);
  if (sessions.length === 0) return metaReply("No other sessions to delete.");

  deleteAllSessions = sessions.map(toPickerEntry);
  return metaPicker(
    `🗑️ PERMANENTLY delete all ${sessions.length} sessions (except the active one)? This cannot be undone.`,
    [
      [
        { label: `🗑️ PERMANENTLY delete ${sessions.length} sessions`, callbackData: "meta:delete_all_confirm" },
        { label: "❌ Cancel", callbackData: "meta:delete_all_cancel" },
      ],
    ],
  );
}

// ---------------------------------------------------------------------------
// tryHandleMetaCallback — callback_query.data router.
// ---------------------------------------------------------------------------

function confirmPromptEffects(
  headlineIcon: string,
  actionLabel: "archive" | "delete",
  entry: PickerEntry,
  warning: string,
  confirmCallback: string,
  cancelCallback: string,
): MetaCallbackEffect[] {
  const verb = actionLabel === "archive" ? "Archive" : "Delete";
  return [
    { kind: "ack", text: "Confirmation required" },
    { kind: "edit", text: `${headlineIcon} Pick a session to ${actionLabel} → ${entry.label}` },
    {
      kind: "reply",
      result: metaReply(`${verb} session "${entry.label}"? ${warning}`, [
        [
          { label: "✅ Confirm", callbackData: confirmCallback },
          { label: "❌ Cancel", callbackData: cancelCallback },
        ],
      ]),
    },
  ];
}

/**
 * Try to handle a `callback_query.data` string as a meta-route. Returns:
 *   - a `MetaCallbackEffect[]` → consumed (caller must NOT forward to AI)
 *   - `null`                    → not a meta callback (doesn't start with "meta:")
 */
export async function tryHandleMetaCallback(
  callbackData: string,
  bot: MetaCommandBot,
  client: SessionOpsClient,
): Promise<MetaCallbackEffect[] | null> {
  if (!callbackData.startsWith("meta:")) return null;
  const rest = callbackData.slice("meta:".length);

  if (rest === "cancel") {
    return [{ kind: "ack", text: "Cancelled" }, { kind: "edit", text: "(switch cancelled)" }];
  }

  if (rest.startsWith("switch_page_")) {
    const arg = rest.slice("switch_page_".length);
    if (arg === "noop") return [{ kind: "ack" }];
    const page = Number.parseInt(arg, 10);
    if (!Number.isFinite(page) || page < 1) return [{ kind: "ack", text: "Bad page" }];
    if (switchPickerSessions.length === 0) {
      return [
        { kind: "ack", text: "Picker expired, run /switch again" },
        { kind: "edit", text: "(picker expired — please run /switch again)" },
      ];
    }
    const current = await client.currentSession(bot);
    const currentId = current?.id ?? null;
    const currentLabel = currentId
      ? (switchPickerSessions.find(s => s.sessionId === currentId)?.label ?? `session ${currentId.slice(0, 8)}`)
      : null;
    const { rows, currentPage, totalPages } = renderPickerPage({
      sessions: switchPickerSessions,
      page,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:cancel",
      labelOf: s => s.label,
      sessionCallbackOf: s => `meta:switch_${s.shortId}`,
    });
    return [
      { kind: "ack" },
      { kind: "edit", text: switchHeadline(currentLabel, currentPage, totalPages), buttons: rows },
    ];
  }

  if (rest.startsWith("switch_")) {
    const shortId = rest.slice("switch_".length);
    if (!SHORT_ID_RE.test(shortId)) return [{ kind: "ack", text: "Bad short id" }];
    const entry = switchPicker.get(shortId);
    if (!entry) {
      return [
        { kind: "ack", text: "Session expired, run /switch again" },
        { kind: "edit", text: "(picker expired — please run /switch again)" },
      ];
    }
    if (!(await client.isAlive(bot))) {
      return [
        { kind: "ack", text: "Bot not alive" },
        { kind: "edit", text: "⚠️ Bot not alive — switch aborted" },
      ];
    }
    const r = await client.resume(bot, entry.sessionId);
    if (!r.ok) return [{ kind: "ack", text: `Resume failed: ${r.reason}` }];
    switchPicker.delete(shortId);
    return [{ kind: "ack" }, { kind: "edit", text: `🔀 → ${entry.label}` }];
  }

  if (rest.startsWith("delete_")) {
    const remainder = rest.slice("delete_".length);

    if (remainder === "all_cancel") {
      return [{ kind: "ack", text: "Cancelled" }, { kind: "edit", text: "(delete all cancelled)" }];
    }
    if (remainder === "all_confirm") {
      if (deleteAllSessions.length === 0) {
        return [
          { kind: "ack", text: "Expired, run /delete hard all again" },
          { kind: "edit", text: "(expired — run /delete hard all again)" },
        ];
      }
      deleteAllSessions = [];
      const result = await client.bulkDelete(bot, true);
      const note = result.skipped > 0 ? ` · ${result.skipped} skipped` : "";
      return [
        { kind: "ack", text: "Deleted" },
        { kind: "edit", text: `🗑️ ${result.processed} sessions permanently deleted.${note}` },
      ];
    }
    if (remainder.startsWith("page_")) {
      const arg = remainder.slice("page_".length);
      if (arg === "noop") return [{ kind: "ack" }];
      const page = Number.parseInt(arg, 10);
      if (!Number.isFinite(page) || page < 1) return [{ kind: "ack", text: "Bad page" }];
      if (deletePickerSessions.length === 0) {
        return [
          { kind: "ack", text: "Picker expired, run /delete again" },
          { kind: "edit", text: "(picker expired — please run /delete again)" },
        ];
      }
      const { rows, currentPage, totalPages } = renderPickerPage({
        sessions: deletePickerSessions,
        page,
        callbackPrefix: "meta:delete",
        cancelCallback: "meta:delete_cancel",
        labelOf: s => s.label,
        sessionCallbackOf: s => `meta:delete_${s.shortId}`,
      });
      return [{ kind: "ack" }, { kind: "edit", text: deleteHeadline(currentPage, totalPages), buttons: rows }];
    }
    if (remainder === "cancel") {
      return [{ kind: "ack", text: "Cancelled" }, { kind: "edit", text: "(delete cancelled)" }];
    }
    if (remainder.startsWith("confirm_")) {
      const shortId = remainder.slice("confirm_".length);
      if (!SHORT_ID_RE.test(shortId)) return [{ kind: "ack", text: "Bad short id" }];
      const entry = deletePicker.get(shortId);
      if (!entry) {
        return [
          { kind: "ack", text: "Prompt expired" },
          { kind: "edit", text: "(prompt expired — run /delete again)" },
        ];
      }
      const r = await client.hardDelete(bot, entry.sessionId);
      if (!r.ok) {
        return [
          { kind: "ack", text: `Delete failed: ${r.reason}` },
          { kind: "edit", text: `⚠️ Delete failed: ${r.reason}` },
        ];
      }
      deletePicker.delete(shortId);
      return [
        { kind: "ack", text: "session deleted" },
        { kind: "edit", text: `🗑️ session "${entry.label}" deleted.` },
      ];
    }
    // Plain picker tap: `delete_<shortId>` → confirmation prompt.
    const shortId = remainder;
    if (!SHORT_ID_RE.test(shortId)) return [{ kind: "ack", text: "Bad short id" }];
    const entry = deletePicker.get(shortId);
    if (!entry) {
      return [{ kind: "ack", text: "Picker expired" }, { kind: "edit", text: "(picker expired — run /delete again)" }];
    }
    return confirmPromptEffects(
      "🗑️",
      "delete",
      entry,
      "This is PERMANENT and cannot be undone.",
      `meta:delete_confirm_${shortId}`,
      "meta:delete_cancel",
    );
  }

  if (rest.startsWith("archive_")) {
    const remainder = rest.slice("archive_".length);

    if (remainder === "all_cancel") {
      return [{ kind: "ack", text: "Cancelled" }, { kind: "edit", text: "(archive all cancelled)" }];
    }
    if (remainder === "all_confirm") {
      if (archiveAllSessions.length === 0) {
        return [
          { kind: "ack", text: "Expired, run /delete all again" },
          { kind: "edit", text: "(expired — run /delete all again)" },
        ];
      }
      archiveAllSessions = [];
      const result = await client.bulkArchive(bot, true);
      const note = result.skipped > 0 ? ` · ${result.skipped} skipped` : "";
      return [
        { kind: "ack", text: "Archived" },
        { kind: "edit", text: `📦 ${result.processed} sessions archived.${note}` },
      ];
    }
    if (remainder.startsWith("page_")) {
      const arg = remainder.slice("page_".length);
      if (arg === "noop") return [{ kind: "ack" }];
      const page = Number.parseInt(arg, 10);
      if (!Number.isFinite(page) || page < 1) return [{ kind: "ack", text: "Bad page" }];
      if (archivePickerSessions.length === 0) {
        return [
          { kind: "ack", text: "Picker expired, run /archive again" },
          { kind: "edit", text: "(picker expired — please run /archive again)" },
        ];
      }
      const { rows, currentPage, totalPages } = renderPickerPage({
        sessions: archivePickerSessions,
        page,
        callbackPrefix: "meta:archive",
        cancelCallback: "meta:archive_cancel",
        labelOf: s => s.label,
        sessionCallbackOf: s => `meta:archive_${s.shortId}`,
      });
      return [{ kind: "ack" }, { kind: "edit", text: archiveHeadline(currentPage, totalPages), buttons: rows }];
    }
    if (remainder === "cancel") {
      return [{ kind: "ack", text: "Cancelled" }, { kind: "edit", text: "(archive cancelled)" }];
    }
    if (remainder.startsWith("confirm_")) {
      const shortId = remainder.slice("confirm_".length);
      if (!SHORT_ID_RE.test(shortId)) return [{ kind: "ack", text: "Bad short id" }];
      const entry = archivePicker.get(shortId);
      if (!entry) {
        return [
          { kind: "ack", text: "Prompt expired" },
          { kind: "edit", text: "(prompt expired — run /archive again)" },
        ];
      }
      const r = await client.archiveSession(bot, entry.sessionId);
      if (!r.ok) {
        return [
          { kind: "ack", text: `Archive failed: ${r.reason}` },
          { kind: "edit", text: `⚠️ Archive failed: ${r.reason}` },
        ];
      }
      archivePicker.delete(shortId);
      return [
        { kind: "ack", text: "session archived" },
        { kind: "edit", text: `📦 session "${entry.label}" archived.` },
      ];
    }
    // Plain picker tap: `archive_<shortId>` → confirmation prompt.
    const shortId = remainder;
    if (!SHORT_ID_RE.test(shortId)) return [{ kind: "ack", text: "Bad short id" }];
    const entry = archivePicker.get(shortId);
    if (!entry) {
      return [
        { kind: "ack", text: "Picker expired" },
        { kind: "edit", text: "(picker expired — run /archive again)" },
      ];
    }
    return confirmPromptEffects(
      "📦",
      "archive",
      entry,
      "(to unarchive, edit the file manually)",
      `meta:archive_confirm_${shortId}`,
      "meta:archive_cancel",
    );
  }

  if (rest.startsWith("effort_")) {
    const remainder = rest.slice("effort_".length);
    if (remainder === "cancel") {
      return [{ kind: "ack", text: "Effort unchanged" }, { kind: "edit", text: "❌ Effort unchanged." }];
    }
    if (!(EFFORT_LEVELS as readonly string[]).includes(remainder)) {
      return [{ kind: "ack", text: "Unknown effort level" }];
    }
    const level = remainder as EffortLevel;
    if (!(await client.isAlive(bot))) {
      return [
        { kind: "ack", text: "Bot not alive" },
        { kind: "edit", text: "⚠️ /effort failed: bot session is not alive." },
      ];
    }
    const r = await client.setEffort(bot, level);
    if (!r.ok) {
      return [
        { kind: "ack", text: `Send failed: ${r.reason}` },
        { kind: "edit", text: `⚠️ /effort failed: ${r.reason}` },
      ];
    }
    return [{ kind: "ack", text: `Effort: ${level}` }, { kind: "edit", text: `🎯 Effort: ${level} ✅` }];
  }

  // Unknown meta:... — consume so it doesn't fall through to AI, but signal gracefully.
  return [{ kind: "ack", text: "Unknown meta action" }];
}

// ---------------------------------------------------------------------------
// Test helpers — clear in-memory state between tests so cross-test leakage
// doesn't happen. Not used by production code paths.
// ---------------------------------------------------------------------------

export function __resetSwitchPickerForTests(): void {
  switchPicker.clear();
  switchPickerSessions = [];
}
export function __resetDeletePickerForTests(): void {
  deletePicker.clear();
  deletePickerSessions = [];
}
export function __resetArchivePickerForTests(): void {
  archivePicker.clear();
  archivePickerSessions = [];
}
export function __resetArchiveAllForTests(): void {
  archiveAllSessions = [];
}
export function __resetDeleteAllForTests(): void {
  deleteAllSessions = [];
}
