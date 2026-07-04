import { describe, expect, test } from "bun:test";
import { OutboundCommandSchema, type OutboundCommand } from "../src/outbound-command";

describe("OutboundCommandSchema — valid commands parse per op", () => {
  test("reply: minimal (only required fields)", () => {
    const parsed = OutboundCommandSchema.parse({ op: "reply", chat_id: "u1", text: "hi" });
    expect(parsed).toEqual({ op: "reply", chat_id: "u1", text: "hi" });
  });

  test("reply: full (every optional field present)", () => {
    const input: OutboundCommand = {
      op: "reply",
      chat_id: "u1",
      text: "hi",
      reply_to: "42",
      files: ["/tmp/a.txt"],
      format: "markdown",
      source: "system",
      buttons: [[{ label: "Yes", callback_id: "yes" }]],
    };
    expect(OutboundCommandSchema.parse(input)).toEqual(input);
  });

  test("react: parses with required fields", () => {
    const input: OutboundCommand = { op: "react", chat_id: "u1", message_id: "42", emoji: "\u{1F44D}" };
    expect(OutboundCommandSchema.parse(input)).toEqual(input);
  });

  test("download_attachment: parses with required fields", () => {
    const input: OutboundCommand = { op: "download_attachment", file_id: "f1" };
    expect(OutboundCommandSchema.parse(input)).toEqual(input);
  });

  test("get_message_by_id: parses with required fields", () => {
    const input: OutboundCommand = { op: "get_message_by_id", chat_id: "u1", message_id: "42" };
    expect(OutboundCommandSchema.parse(input)).toEqual(input);
  });
});

describe("OutboundCommandSchema — rejects bad shape", () => {
  test("unknown op is rejected", () => {
    expect(() => OutboundCommandSchema.parse({ op: "edit_message" })).toThrow();
  });

  test("reply missing required 'text' is rejected", () => {
    expect(() => OutboundCommandSchema.parse({ op: "reply", chat_id: "u1" })).toThrow();
  });

  test("reply with wrong-typed field is rejected", () => {
    expect(() => OutboundCommandSchema.parse({ op: "reply", chat_id: "u1", text: 123 })).toThrow();
  });

  test("reply with invalid 'format' enum value is rejected", () => {
    expect(() =>
      OutboundCommandSchema.parse({ op: "reply", chat_id: "u1", text: "hi", format: "html" }),
    ).toThrow();
  });

  test("react missing required 'emoji' is rejected", () => {
    expect(() => OutboundCommandSchema.parse({ op: "react", chat_id: "u1", message_id: "42" })).toThrow();
  });

  test("strict: an unrecognized key on an otherwise-valid reply is rejected", () => {
    expect(() =>
      OutboundCommandSchema.parse({ op: "reply", chat_id: "u1", text: "hi", extra_field: true }),
    ).toThrow();
  });

  test("strict: an unrecognized key on an otherwise-valid react is rejected", () => {
    expect(() =>
      OutboundCommandSchema.parse({
        op: "react",
        chat_id: "u1",
        message_id: "42",
        emoji: "\u{1F44D}",
        extra_field: true,
      }),
    ).toThrow();
  });
});
