#!/usr/bin/env bun
/**
 * Task H2, Fase 2 — Stop hook: reply-guard v2 (fix FUNC-3).
 *
 * Replaces `plugins/telegram/hooks/telegram-reply-guard.ts` (mirza-marketplace),
 * whose known hole is recon-hooks.md §A / task-H2-brief.md FUNC-3:
 *
 *   - The old guard scanned the transcript for the LAST inbound telegram
 *     message and blocked the Stop only if there was NO reply ANYWHERE after
 *     it. But `immediate-reply` (a mandatory skill) requires an ack reply
 *     BEFORE the first non-reply tool call on almost every telegram-driven
 *     turn — so that ack alone always satisfied "a reply exists after the
 *     inbound message", even when the turn's actual final answer never got
 *     sent. The guard was near-dead for its main intended case: ack, then do
 *     work, then stop without ever sending the real answer.
 *
 *   - Fix: stop asking "is there a reply after the inbound message" and ask
 *     instead "is there a reply after the LAST non-reply tool use". If the
 *     most recent substantive work (a non-reply tool call — Bash, Read, an
 *     agent dispatch, whatever) was never followed by another reply-tool
 *     call, that is exactly the ack-then-silently-finish-tools-then-stop
 *     failure mode FUNC-3 named, and we block. An ack that comes BEFORE any
 *     tool use (or a turn with no tool use at all) no longer trivially
 *     satisfies the guard — see decideStop's doc comment for the exact
 *     comparison and analyzeTranscript.test / reply-guard.test for the five
 *     scenarios task-H2-brief.md requires.
 *
 * DESIGN CHOICE — local computation, not hostd RPC (documented per
 * task-H2-brief.md's "pilih yang paling test-able & sederhana; JELASKAN"):
 * the Stop hook's stdin already gives us `transcript_path`, a JSONL file
 * that contains BOTH the inbound telegram marker (the `<channel
 * source="telegram" ...>` tag literal-injected into the user turn's text —
 * see plugins/telegram's channel-tag convention) and every tool_use call
 * this turn made, including the reply tool. Everything the guard needs is
 * already on disk, in order, for free. Routing through hostd's `stop.check`
 * RPC would:
 *   (a) add a live IPC round-trip at the exact moment (Stop) the session may
 *       already be tearing down / hostd may be mid clear-barrier work,
 *   (b) still require the hook to parse the transcript anyway to find which
 *       chat_id/message_id to hand hostd (messages-store is keyed on
 *       bot_id+channel+chat_id+message_id, not "this session's transcript"),
 *       so no parsing work is actually saved — it's just relocated,
 *   (c) make the core decision logic un-unit-testable without a live
 *       Database fixture, instead of pure functions over synthetic JSONL
 *       fixtures (this file's exported `analyzeTranscript`/`decideStop`,
 *       exactly mirroring trailer-guard.ts's proven pure-function-plus-thin-
 *       stdin-entrypoint shape).
 * Local computation has none of these costs and is self-contained, so it's
 * the simpler and more test-able of the two options.
 *
 * `stop_hook_active` loop-guard is preserved unchanged from v1: when true,
 * this Stop was itself triggered by a previous Stop hook's block for this
 * same stop event, and Claude Code hands us this flag specifically so hooks
 * can avoid blocking forever; we always allow in that case (see decideStop).
 */
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Reply-tool name matching.
// ---------------------------------------------------------------------------

/**
 * Tool names that count as a substantive telegram reply. Matches cc-stub's
 * raw tool name ("reply", see src/tools.ts's TOOL_DEFINITIONS) as well as any
 * MCP-qualified form the tool surfaces under to the model (e.g.
 * "mcp__cc-stub__reply", "mcp__plugin_telegram_telegram__reply") — anything
 * whose last "_"/"."-separated segment is literally "reply", case-
 * insensitive. Deliberately does NOT match "react" / "download_attachment" /
 * "get_message_by_id" / "edit_message" — none of those are an answer to the
 * user, so none of them should satisfy this guard.
 */
const REPLY_TOOL_RE = /(^|[_.])reply$/i;

export function isReplyToolName(name: string): boolean {
  return REPLY_TOOL_RE.test(name);
}

// ---------------------------------------------------------------------------
// Telegram-driven marker.
// ---------------------------------------------------------------------------

/**
 * The literal tag every inbound telegram message is wrapped in before it
 * reaches the transcript (see plugins/telegram's channel-tag convention:
 * `<channel source="telegram" chat_id="..." message_id="..." user="..."
 * ts="...">`). Presence anywhere in a user turn's text means this transcript
 * is telegram-driven.
 *
 * Matches the reference pattern from the old
 * `plugins/telegram/hooks/telegram-reply-guard.ts` (`/<channel\b[^>]*\bsource=
 * "[^"]*telegram[^"]*"/`), plus a case-insensitive flag: `source` need not be
 * the first attribute (real tags also carry chat_id/message_id/user/ts, and
 * their order is not a contract this guard should depend on), and the
 * source value only needs to CONTAIN "telegram" rather than equal it
 * exactly. Still fail-safe: a non-matching/malformed tag simply doesn't
 * count as telegram-driven, same as today.
 */
const TELEGRAM_MARKER_RE = /<channel\b[^>]*\bsource="[^"]*telegram[^"]*"/i;

function collectTextFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        out.push((block as { text: string }).text);
      }
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Transcript analysis (pure, unit-testable with synthetic JSONL fixtures).
// ---------------------------------------------------------------------------

export interface TranscriptAnalysis {
  /** Whether the LATEST inbound user turn (not "any" user turn, ever) is telegram-tagged. */
  telegramDriven: boolean;
  /** Line index of the latest user turn whose text matched the telegram marker; -1 if none ever matched. */
  latestInboundPos: number;
  /** Position of the last tool_use whose name is NOT a reply tool, since the current user turn began; -1 if none occurred. */
  latestNonReplyToolPos: number;
  /** Position of the last tool_use whose name IS a reply tool, since the current user turn began; -1 if none occurred. */
  latestReplyPos: number;
}

/**
 * Analyze a transcript given as an array of raw JSONL lines (already split
 * on "\n" — not yet parsed). One shared, monotonically increasing `pos`
 * counter is assigned to every tool_use block encountered, in transcript
 * (chronological) order, across all lines and content blocks; only the two
 * running maxima (last reply-tool pos, last non-reply-tool pos) are kept.
 *
 * FIX (task-H2 review, "telegramDriven sticky" regression): a naive
 * `telegramDriven ||= matched` (set once, never revisited — the previous
 * shape of this function) makes telegramDriven session-wide sticky: once
 * ANY user turn in the transcript carries the telegram marker, EVERY later
 * turn in the same transcript — including a later, purely-local turn with
 * no telegram tag at all — inherits it forever. Combined with
 * latestReplyPos/latestNonReplyToolPos also accumulating across the WHOLE
 * transcript, a local turn that runs a tool after an earlier, already-
 * answered telegram cycle looks identical to "telegram-driven work with no
 * reply yet" and gets wrongly blocked.
 *
 * Fix, two parts, both keyed on genuine user-text turns only (a "user" line
 * whose content contributes no `.text` block — e.g. a bare tool_result echo
 * — is not a turn boundary and is ignored for both):
 *   1. `telegramDriven` is OVERWRITTEN (not OR'd) on every genuine user
 *      turn, from that turn's match result alone. So it always reflects
 *      "is the LATEST inbound telegram-tagged", matching the old
 *      telegram-reply-guard.ts's `latestInboundIdx`-based intent, instead of
 *      "was ANY inbound, ever, telegram-tagged".
 *   2. `latestNonReplyToolPos`/`latestReplyPos` are RESET to -1 at the start
 *      of every genuine user turn (telegram or not) — i.e. tool/reply
 *      bookkeeping only ever reflects activity since the CURRENT turn
 *      began, never a prior, already-concluded turn. This is what makes "an
 *      already-answered telegram cycle, followed by a purely-local turn
 *      that runs a tool" evaluate against the local turn's OWN (empty)
 *      reply/tool history rather than the stale telegram turn's.
 * `latestInboundPos` is exposed (line index of the latest telegram-marker
 * match) for parity with the old guard's `latestInboundIdx`, though the
 * decision in decideStop no longer needs to compare against it directly —
 * (1)+(2) already make telegramDriven and the reply/tool positions
 * consistently "current-turn-only".
 *
 * Malformed or unrecognized lines/blocks are skipped silently — fail-open
 * per line/block, matching trailer-guard.ts's stdin-parsing posture — rather
 * than aborting the whole scan. The on-disk transcript schema is internal to
 * Claude Code and can change between versions (official hooks reference),
 * so this function only ever reads a small, defensively-checked subset of
 * fields (`type`, `message.content`, and within content blocks `type`,
 * `text`, `name`) and never throws on anything else it doesn't recognize.
 */
export function analyzeTranscript(lines: string[]): TranscriptAnalysis {
  let telegramDriven = false;
  let latestInboundPos = -1;
  let latestNonReplyToolPos = -1;
  let latestReplyPos = -1;
  let pos = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; message?: { content?: unknown } };
    const content = e.message?.content;

    if (e.type === "user") {
      const texts = collectTextFromContent(content);
      if (texts.length > 0) {
        // A genuine inbound user turn (has actual text, unlike a bare
        // tool_result echo) — re-derive telegramDriven from THIS turn only,
        // and start a fresh reply/tool window for it. See fix note above.
        const matched = texts.some((text) => TELEGRAM_MARKER_RE.test(text));
        telegramDriven = matched;
        latestNonReplyToolPos = -1;
        latestReplyPos = -1;
        if (matched) latestInboundPos = idx;
      }
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; name?: unknown };
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        if (isReplyToolName(b.name)) {
          latestReplyPos = pos;
        } else {
          latestNonReplyToolPos = pos;
        }
        pos += 1;
      }
    }
  }

  return { telegramDriven, latestInboundPos, latestNonReplyToolPos, latestReplyPos };
}

// ---------------------------------------------------------------------------
// Stop decision.
// ---------------------------------------------------------------------------

export interface StopHookInput {
  stop_hook_active?: boolean;
  transcriptLines: string[];
}

export interface StopDecision {
  block: boolean;
  reason?: string;
}

/**
 * FUNC-3 fix, spelled out: block iff (a) this Stop wasn't itself already
 * forced by a previous block (`stop_hook_active`, anti-loop — always
 * allowed), (b) the LATEST inbound user turn is telegram-driven, and (c) the
 * last reply-tool call, SINCE THAT TURN BEGAN, is NOT strictly after the
 * last non-reply tool call since that turn began —
 * `latestReplyPos <= latestNonReplyToolPos`, both defaulting to -1 when
 * absent and both reset at the start of the current turn by
 * analyzeTranscript (see its fix note). That single comparison covers every
 * required scenario:
 *
 *   - inbound -> ack(reply) -> tool -> STOP: reply pos 0, tool pos 1,
 *     0 <= 1 -> BLOCK (the old guard wrongly allowed this — ack "satisfied"
 *     it — this is the case FUNC-3 exists to fix).
 *   - inbound -> ack -> tool -> final reply -> STOP: reply pos 2, tool pos
 *     1, 2 <= 1 is false -> allow.
 *   - inbound -> reply (no tool at all) -> STOP: tool pos -1 (never set),
 *     reply pos 0, 0 <= -1 is false -> allow (nothing to be "after").
 *   - no telegram marker at all -> allow, regardless of tool/reply shape.
 *   - stop_hook_active true -> allow, regardless of everything else.
 *   - [inbound(telegram) -> ack -> tool -> final reply] THEN a later, purely
 *     local turn (no telegram tag) that runs its own tool -> STOP: the local
 *     turn overwrites telegramDriven to false (it is now the LATEST turn),
 *     so this allows regardless of the earlier telegram cycle's shape —
 *     fixes the "telegramDriven sticky" regression (task-H2 review item 1).
 */
export function decideStop(input: StopHookInput): StopDecision {
  if (input.stop_hook_active) return { block: false };

  const { telegramDriven, latestNonReplyToolPos, latestReplyPos } = analyzeTranscript(input.transcriptLines);
  if (!telegramDriven) return { block: false };

  if (latestReplyPos <= latestNonReplyToolPos) {
    return {
      block: true,
      reason:
        "reply-guard: turn ini dipicu pesan Telegram, dan tool non-reply terakhir tidak diikuti balasan " +
        "substantif sesudahnya (mis. ack di awal turn lalu lupa mengirim jawaban akhir). Kirim balasan via " +
        "reply tool sebelum berhenti.",
    };
  }
  return { block: false };
}

// ---------------------------------------------------------------------------
// Stop entrypoint.
// ---------------------------------------------------------------------------

function readTranscriptLines(transcriptPath: string): string[] {
  try {
    return readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return [];
  }
}

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let input: { stop_hook_active?: unknown; transcript_path?: unknown; hook_event_name?: unknown };
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  // NOTE: the two try/catches above (unreadable stdin, unparseable JSON) fail
  // OPEN — a malformed/irrelevant hook payload is not something this guard
  // can or should block on.
  if (typeof input?.hook_event_name === "string" && input.hook_event_name !== "Stop") return;

  const transcriptPath = input?.transcript_path;
  const transcriptLines = typeof transcriptPath === "string" ? readTranscriptLines(transcriptPath) : [];

  try {
    const decision = decideStop({
      stop_hook_active: Boolean(input?.stop_hook_active),
      transcriptLines,
    });
    if (!decision.block) return;
    process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }));
  } catch {
    // Fail OPEN on internal errors here — the opposite of trailer-guard's
    // deliberate fail-closed. A wrongly-allowed Stop just ends the turn (the
    // status quo before this hook existed); a wrongly-blocked Stop, on an
    // internal bug we didn't anticipate, risks trapping the agent in a
    // continue-loop it has no way out of. Prefer the safer failure mode.
    return;
  }
}

if (import.meta.main) main();
