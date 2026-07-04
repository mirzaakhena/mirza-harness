import { describe, expect, test } from "bun:test";
import {
  ReplyToolInput,
  ReplyToolJsonSchema,
  AgentSendToolInput,
  AgentSendPayloadSchema,
  ButtonsSchema,
  TelegramOutboundParams,
  AgentStatusParams,
  AgentSendParams,
} from "../src/rpc";

describe("ReplyToolInput", () => {
  test("accepts the same shape the legacy `reply` tool did", () => {
    const parsed = ReplyToolInput.parse({ chat_id: "1", text: "hi", format: "markdown", buttons: [[{ label: "Yes", callback_id: "yes" }]] });
    expect(parsed.chat_id).toBe("1");
    expect(parsed.buttons?.[0]?.[0]?.callback_id).toBe("yes");
  });

  test("rejects unknown keys (.strict())", () => {
    expect(() => ReplyToolInput.parse({ chat_id: "1", text: "hi", bogus: true })).toThrow();
  });

  test("generated inputSchema exposes chat_id/text as required, buttons as optional array", () => {
    expect(ReplyToolJsonSchema.type).toBe("object");
    expect((ReplyToolJsonSchema.required as string[]).sort()).toEqual(["chat_id", "text"]);
    const props = ReplyToolJsonSchema.properties as Record<string, unknown>;
    expect(props.buttons).toBeDefined();
  });
});

describe("ButtonsSchema", () => {
  test("valid rows pass", () => {
    expect(() => ButtonsSchema.parse([[{ label: "A", callback_id: "a" }]])).not.toThrow();
  });

  test("duplicate callback_id across rows rejected", () => {
    const result = ButtonsSchema.safeParse([[{ label: "A", callback_id: "dup" }], [{ label: "B", callback_id: "dup" }]]);
    expect(result.success).toBe(false);
  });

  test("bad callback_id shape rejected", () => {
    expect(ButtonsSchema.safeParse([[{ label: "A", callback_id: "NOT-VALID" }]]).success).toBe(false);
  });

  test("more than 8 rows rejected", () => {
    const rows = Array.from({ length: 9 }, (_, i) => [{ label: `B${i}`, callback_id: `b${i}` }]);
    expect(ButtonsSchema.safeParse(rows).success).toBe(false);
  });
});

describe("AgentSendPayloadSchema", () => {
  test("body over 8KB rejected", () => {
    const big = "x".repeat(8 * 1024 + 1);
    expect(AgentSendPayloadSchema.safeParse({ kind: "prompt", body: big }).success).toBe(false);
  });

  test("body at exactly 8KB accepted", () => {
    const exact = "x".repeat(8 * 1024);
    expect(AgentSendPayloadSchema.safeParse({ kind: "prompt", body: exact }).success).toBe(true);
  });

  test("hop_count above MAX_HOP rejected", () => {
    expect(AgentSendPayloadSchema.safeParse({ kind: "prompt", body: "hi", hop_count: 6 }).success).toBe(false);
  });

  test("hop_count omitted is fine (defaults applied by caller, not schema)", () => {
    const parsed = AgentSendPayloadSchema.parse({ kind: "prompt", body: "hi" });
    expect(parsed.hop_count).toBeUndefined();
  });
});

describe("AgentSendToolInput (MCP surface)", () => {
  test("never accepts a `from` field — identity is never AI-supplied", () => {
    expect(() => AgentSendToolInput.parse({ target: "bot-02", payload: { kind: "prompt", body: "hi" }, from: "spoofed" })).toThrow();
  });

  test("target accepts string or array", () => {
    expect(AgentSendToolInput.parse({ target: "bot-02", payload: { kind: "prompt", body: "hi" } }).target).toBe("bot-02");
    expect(AgentSendToolInput.parse({ target: ["bot-02", "bot-03"], payload: { kind: "prompt", body: "hi" } }).target).toEqual([
      "bot-02",
      "bot-03",
    ]);
  });
});

describe("TelegramOutboundParams (hostd RPC boundary)", () => {
  test("valid reply cmd", () => {
    const parsed = TelegramOutboundParams.parse({ bot_id: "bot-03", cmd: { op: "reply", chat_id: "1", text: "hi" } });
    expect(parsed.bot_id).toBe("bot-03");
    expect(parsed.cmd.op).toBe("reply");
  });

  test("missing bot_id rejected", () => {
    expect(TelegramOutboundParams.safeParse({ cmd: { op: "reply", chat_id: "1", text: "hi" } }).success).toBe(false);
  });

  test("cmd with unknown op rejected (discriminated union)", () => {
    expect(TelegramOutboundParams.safeParse({ bot_id: "b", cmd: { op: "bogus" } }).success).toBe(false);
  });
});

describe("AgentStatusParams / AgentSendParams (hostd RPC boundary)", () => {
  test("AgentStatusParams requires non-empty name", () => {
    expect(AgentStatusParams.safeParse({ name: "" }).success).toBe(false);
    expect(AgentStatusParams.safeParse({ name: "bot-02" }).success).toBe(true);
  });

  test("AgentSendParams accepts optional from (cc-stub fills it in, never the AI)", () => {
    const parsed = AgentSendParams.parse({ from: "bot-01", target: "bot-02", payload: { kind: "prompt", body: "hi" } });
    expect(parsed.from).toBe("bot-01");
    const parsedNoFrom = AgentSendParams.parse({ target: "bot-02", payload: { kind: "prompt", body: "hi" } });
    expect(parsedNoFrom.from).toBeUndefined();
  });
});
