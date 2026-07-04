import { describe, expect, test } from "bun:test";
import { analyzeTranscript, decideStop, isReplyToolName, type StopHookInput } from "../hooks/reply-guard";

// ---------------------------------------------------------------------------
// Fixture builders — one JSONL line per transcript "turn". Kept close to the
// real Claude Code transcript shape (type: user/assistant, message.content
// either a string or an array of {type:"text"} / {type:"tool_use"} blocks)
// without depending on that on-disk schema being stable (see reply-guard.ts's
// docstring) — these are synthetic fixtures for the pure functions only.
// ---------------------------------------------------------------------------

function userText(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } });
}

function assistantToolUse(name: string, id = `toolu_${name}_${Math.random()}`): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  });
}

function toolResult(id: string, content = "ok"): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

const INBOUND = userText('<channel source="telegram" chat_id="1" message_id="1" user="mirza" ts="0">halo</channel>');
const NOT_TELEGRAM_INBOUND = userText("halo, tolong bantu saya");

const REPLY_TOOL_NAME = "mcp__plugin_telegram_telegram__reply";
const NON_REPLY_TOOL_NAME = "Bash";

function ackReply(): string {
  return assistantToolUse(REPLY_TOOL_NAME);
}
function nonReplyTool(): string {
  return assistantToolUse(NON_REPLY_TOOL_NAME);
}
function finalReply(): string {
  return assistantToolUse(REPLY_TOOL_NAME);
}

// ---------------------------------------------------------------------------
// isReplyToolName
// ---------------------------------------------------------------------------

describe("isReplyToolName", () => {
  test("raw cc-stub name", () => {
    expect(isReplyToolName("reply")).toBe(true);
  });
  test("MCP-qualified names", () => {
    expect(isReplyToolName("mcp__cc-stub__reply")).toBe(true);
    expect(isReplyToolName("mcp__plugin_telegram_telegram__reply")).toBe(true);
  });
  test("case-insensitive", () => {
    expect(isReplyToolName("Reply")).toBe(true);
  });
  test("non-reply tools are not matched", () => {
    expect(isReplyToolName("react")).toBe(false);
    expect(isReplyToolName("mcp__cc-stub__react")).toBe(false);
    expect(isReplyToolName("download_attachment")).toBe(false);
    expect(isReplyToolName("get_message_by_id")).toBe(false);
    expect(isReplyToolName("Bash")).toBe(false);
  });
  test("a tool name that merely contains 'reply' as a substring, not a segment, is not matched", () => {
    expect(isReplyToolName("replyish")).toBe(false);
    expect(isReplyToolName("noreply")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyzeTranscript
// ---------------------------------------------------------------------------

describe("analyzeTranscript", () => {
  test("empty transcript -> not telegram-driven, no positions", () => {
    const r = analyzeTranscript([]);
    expect(r).toEqual({ telegramDriven: false, latestInboundPos: -1, latestNonReplyToolPos: -1, latestReplyPos: -1 });
  });

  test("malformed lines are skipped, not fatal", () => {
    const lines = ["not json {{{", "", "   ", INBOUND, nonReplyTool()];
    const r = analyzeTranscript(lines);
    expect(r.telegramDriven).toBe(true);
    expect(r.latestNonReplyToolPos).toBe(0);
  });

  test("tracks reply vs non-reply tool positions in transcript order", () => {
    const lines = [INBOUND, ackReply(), nonReplyTool(), finalReply()];
    const r = analyzeTranscript(lines);
    expect(r.telegramDriven).toBe(true);
    expect(r.latestReplyPos).toBe(2); // final reply, pos after ack(0) and tool(1)
    expect(r.latestNonReplyToolPos).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// decideStop — the five required FUNC-3 scenarios.
// ---------------------------------------------------------------------------

describe("decideStop — FUNC-3 required scenarios", () => {
  test("inbound -> ack -> tool -> STOP without further reply -> BLOCK (old guard wrongly allowed this)", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, ackReply(), nonReplyTool()],
    };
    const d = decideStop(input);
    expect(d.block).toBe(true);
    expect(d.reason).toMatch(/reply-guard/);
  });

  test("inbound -> ack -> tool -> final reply -> STOP -> allow", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, ackReply(), nonReplyTool(), finalReply()],
    };
    expect(decideStop(input).block).toBe(false);
  });

  test("not telegram-driven -> allow, even with tool-then-nothing shape", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [NOT_TELEGRAM_INBOUND, nonReplyTool()],
    };
    expect(decideStop(input).block).toBe(false);
  });

  test("stop_hook_active true -> allow (anti-loop), even with block-shaped transcript", () => {
    const input: StopHookInput = {
      stop_hook_active: true,
      transcriptLines: [INBOUND, ackReply(), nonReplyTool()],
    };
    expect(decideStop(input).block).toBe(false);
  });

  test("inbound -> reply immediately, no tool at all -> allow", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, finalReply()],
    };
    expect(decideStop(input).block).toBe(false);
  });
});

describe("decideStop — additional edge cases", () => {
  test("inbound with a tool_result line (not a tool_use) does not count as a tool call", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, ackReply(), toolResult("toolu_x")],
    };
    // ack(pos0) is the only tool_use; no non-reply tool_use exists (-1),
    // so 0 <= -1 is false -> allow.
    expect(decideStop(input).block).toBe(false);
  });

  test("inbound with no reply and no tool at all -> block (nothing ever answered)", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND],
    };
    expect(decideStop(input).block).toBe(true);
  });

  test("inbound -> tool -> no reply at all -> block", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, nonReplyTool()],
    };
    expect(decideStop(input).block).toBe(true);
  });

  test("react (not reply) after the last tool does not satisfy the guard", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, ackReply(), nonReplyTool(), assistantToolUse("react")],
    };
    expect(decideStop(input).block).toBe(true);
  });

  test("multiple non-reply tools followed by one final reply -> allow", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, ackReply(), nonReplyTool(), nonReplyTool(), nonReplyTool(), finalReply()],
    };
    expect(decideStop(input).block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reviewer fix-pass item 1 (M, regression): telegramDriven must NOT be
// session-wide sticky. A fully-concluded telegram cycle (ack -> tool ->
// final reply, already allowed) followed by a LATER, purely-local turn (no
// telegram tag) that runs its own tool must still ALLOW — the old (buggy)
// shape here would have latched telegramDriven=true forever from the first
// inbound and wrongly blocked the local turn's tool-then-stop shape.
// ---------------------------------------------------------------------------

describe("decideStop — telegramDriven must reflect the LATEST inbound, not any-ever (fix-pass item 1)", () => {
  test("[inbound(telegram) -> ack -> tool -> final reply] then a later local (non-telegram) turn with its own tool -> STOP -> ALLOW", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [
        INBOUND,
        ackReply(),
        nonReplyTool(),
        finalReply(),
        // A brand-new, purely local turn begins here — no telegram tag.
        NOT_TELEGRAM_INBOUND,
        nonReplyTool(),
      ],
    };
    const d = decideStop(input);
    expect(d.block).toBe(false);
  });

  test("analyzeTranscript reflects the same: telegramDriven flips false once a later local turn arrives", () => {
    const lines = [INBOUND, ackReply(), nonReplyTool(), finalReply(), NOT_TELEGRAM_INBOUND, nonReplyTool()];
    const r = analyzeTranscript(lines);
    expect(r.telegramDriven).toBe(false);
    // latestInboundPos still remembers WHERE the last telegram marker was
    // seen (line index 0), even though it's no longer the active turn.
    expect(r.latestInboundPos).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reviewer fix-pass item 2 (I): same-message (genuinely-parallel) tool_use
// blocks. Claude Code can emit multiple tool_use blocks in a single
// assistant message when tools run in parallel; the transcript has no
// wall-clock ordering finer than "this message". Policy choice, documented
// here and enforced by these two tests: array position within the message's
// content is treated as chronological order (first element = earlier). This
// is a deliberate choice — assert BOTH directions so a future accidental
// change to this policy fails loudly here.
// ---------------------------------------------------------------------------

function sameMessageToolUses(...names: string[]): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: names.map((name, i) => ({ type: "tool_use", id: `toolu_${i}_${name}`, name, input: {} })),
    },
  });
}

describe("decideStop — same-message tool ordering is array-position (fix-pass item 2)", () => {
  test("[reply, Bash] in one message -> reply treated as BEFORE the tool -> BLOCK", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, sameMessageToolUses(REPLY_TOOL_NAME, NON_REPLY_TOOL_NAME)],
    };
    expect(decideStop(input).block).toBe(true);
  });

  test("[Bash, reply] in one message -> tool treated as BEFORE the reply -> ALLOW", () => {
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [INBOUND, sameMessageToolUses(NON_REPLY_TOOL_NAME, REPLY_TOOL_NAME)],
    };
    expect(decideStop(input).block).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reviewer fix-pass item 3 (I): TELEGRAM_MARKER_RE robustness. The reference
// pattern (plugins/telegram/hooks/telegram-reply-guard.ts) tolerates any
// attribute order — `source="telegram"` need not be the first attribute on
// the `<channel ...>` tag. The previous, stricter regex here required source
// to be the first attribute; loosen it to match, while staying fail-safe
// (still requires the literal `<channel` + `source="..telegram.."`).
// ---------------------------------------------------------------------------

describe("TELEGRAM_MARKER_RE / telegramDriven — attribute-order robustness (fix-pass item 3)", () => {
  test("source attribute appearing after other attributes is still recognized as telegram-driven", () => {
    const inboundOtherAttrsFirst = userText(
      '<channel chat_id="1" message_id="1" source="telegram" user="mirza" ts="0">halo</channel>',
    );
    const r = analyzeTranscript([inboundOtherAttrsFirst]);
    expect(r.telegramDriven).toBe(true);
  });

  test("decideStop still applies FUNC-3 logic once source is recognized with attributes reordered", () => {
    const inboundOtherAttrsFirst = userText(
      '<channel chat_id="1" message_id="1" source="telegram" user="mirza" ts="0">halo</channel>',
    );
    const input: StopHookInput = {
      stop_hook_active: false,
      transcriptLines: [inboundOtherAttrsFirst, ackReply(), nonReplyTool()],
    };
    expect(decideStop(input).block).toBe(true);
  });
});
