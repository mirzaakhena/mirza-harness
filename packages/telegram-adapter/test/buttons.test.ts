// Ported 1:1 from plugins/telegram/buttons.test.ts (mirza-marketplace).
// Only import path and style conventions adapted (semicolons, double quotes).

import { describe, test, expect } from "bun:test";
import {
  validateButtons,
  parseAiCallbackData,
  buildKeyboard,
  findButtonLabel,
  AI_CALLBACK_PREFIX,
} from "../src/buttons";

describe("buttons: validateButtons", () => {
  test("accepts a valid single row with two buttons", () => {
    const r = validateButtons([
      [
        { label: "Yes", callback_id: "yes" },
        { label: "No", callback_id: "no" },
      ],
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rows.length).toBe(1);
      expect(r.rows[0].length).toBe(2);
      expect(r.rows[0][0]).toEqual({ label: "Yes", callback_id: "yes" });
    }
  });

  test("accepts multi-row vertical layout", () => {
    const r = validateButtons([
      [{ label: "Option A", callback_id: "opt_a" }],
      [{ label: "Option B", callback_id: "opt_b" }],
      [{ label: "Manual", callback_id: "manual" }],
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows.length).toBe(3);
  });

  test("rejects non-array input", () => {
    expect(validateButtons("hello").ok).toBe(false);
    expect(validateButtons(null).ok).toBe(false);
    expect(validateButtons({}).ok).toBe(false);
    expect(validateButtons(42).ok).toBe(false);
  });

  test("rejects empty rows array", () => {
    expect(validateButtons([]).ok).toBe(false);
  });

  test("rejects empty inner row", () => {
    expect(validateButtons([[]]).ok).toBe(false);
  });

  test("rejects non-array row", () => {
    expect(validateButtons(["not-an-array"]).ok).toBe(false);
  });

  test("rejects button that is not an object", () => {
    expect(validateButtons([["not-object"]]).ok).toBe(false);
    expect(validateButtons([[42]]).ok).toBe(false);
    expect(validateButtons([[null]]).ok).toBe(false);
  });

  test("rejects missing label", () => {
    expect(validateButtons([[{ callback_id: "yes" }]]).ok).toBe(false);
  });

  test("rejects empty label", () => {
    expect(validateButtons([[{ label: "", callback_id: "yes" }]]).ok).toBe(false);
  });

  test("rejects label exceeding 64 chars", () => {
    const longLabel = "x".repeat(65);
    expect(validateButtons([[{ label: longLabel, callback_id: "yes" }]]).ok).toBe(false);
  });

  test("accepts label exactly 64 chars", () => {
    const maxLabel = "x".repeat(64);
    expect(validateButtons([[{ label: maxLabel, callback_id: "yes" }]]).ok).toBe(true);
  });

  test("rejects callback_id with uppercase", () => {
    expect(validateButtons([[{ label: "Yes", callback_id: "YES" }]]).ok).toBe(false);
  });

  test("rejects callback_id with dash", () => {
    expect(validateButtons([[{ label: "Yes", callback_id: "opt-a" }]]).ok).toBe(false);
  });

  test("rejects callback_id with colon (would collide with namespace separator)", () => {
    expect(validateButtons([[{ label: "Yes", callback_id: "opt:a" }]]).ok).toBe(false);
  });

  test("rejects empty callback_id", () => {
    expect(validateButtons([[{ label: "Yes", callback_id: "" }]]).ok).toBe(false);
  });

  test("rejects callback_id exceeding 32 chars", () => {
    const longId = "x".repeat(33);
    expect(validateButtons([[{ label: "Yes", callback_id: longId }]]).ok).toBe(false);
  });

  test("accepts callback_id exactly 32 chars", () => {
    const maxId = "x".repeat(32);
    expect(validateButtons([[{ label: "Yes", callback_id: maxId }]]).ok).toBe(true);
  });

  test("rejects duplicate callback_id in same call (same row)", () => {
    expect(
      validateButtons([
        [
          { label: "A", callback_id: "opt" },
          { label: "B", callback_id: "opt" },
        ],
      ]).ok,
    ).toBe(false);
  });

  test("rejects duplicate callback_id across rows", () => {
    expect(
      validateButtons([
        [{ label: "A", callback_id: "opt" }],
        [{ label: "B", callback_id: "opt" }],
      ]).ok,
    ).toBe(false);
  });

  test("rejects too many rows", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => [
      { label: "X", callback_id: `o${i}` },
    ]);
    expect(validateButtons(tooMany).ok).toBe(false);
  });

  test("accepts exactly 8 rows (boundary)", () => {
    const eightRows = Array.from({ length: 8 }, (_, i) => [
      { label: "X", callback_id: `o${i}` },
    ]);
    expect(validateButtons(eightRows).ok).toBe(true);
  });

  test("rejects too many buttons per row", () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      label: "X",
      callback_id: `o${i}`,
    }));
    expect(validateButtons([tooMany]).ok).toBe(false);
  });
});

describe("buttons: parseAiCallbackData", () => {
  test("parses valid ai: prefix", () => {
    expect(parseAiCallbackData("ai:yes")).toEqual({ callback_id: "yes" });
    expect(parseAiCallbackData("ai:opt_a")).toEqual({ callback_id: "opt_a" });
  });

  test("returns null for missing prefix", () => {
    expect(parseAiCallbackData("yes")).toBe(null);
    expect(parseAiCallbackData("perm:allow:abc12")).toBe(null);
  });

  test("returns null for malformed callback_id", () => {
    expect(parseAiCallbackData("ai:Y")).toBe(null); // uppercase
    expect(parseAiCallbackData("ai:a-b")).toBe(null); // dash
    expect(parseAiCallbackData("ai:")).toBe(null); // empty
  });

  test("returns null for callback_id too long", () => {
    expect(parseAiCallbackData(`ai:${"x".repeat(33)}`)).toBe(null);
  });

  test("handles colon in payload conservatively", () => {
    // 'ai:foo:bar' — extracting after first prefix would yield 'foo:bar' which
    // fails CALLBACK_ID_RE → null. Defends against payload smuggling.
    expect(parseAiCallbackData("ai:foo:bar")).toBe(null);
  });
});

describe("buttons: buildKeyboard", () => {
  test("builds keyboard with ai: prefixed callback_data", () => {
    const kb = buildKeyboard([
      [
        { label: "Yes", callback_id: "yes" },
        { label: "No", callback_id: "no" },
      ],
    ]);
    const json = kb.inline_keyboard;
    expect(json.length).toBe(1); // 1 row
    expect(json[0].length).toBe(2); // 2 buttons
    expect(json[0][0]).toMatchObject({ text: "Yes", callback_data: "ai:yes" });
    expect(json[0][1]).toMatchObject({ text: "No", callback_data: "ai:no" });
  });

  test("multi-row keyboard", () => {
    const kb = buildKeyboard([
      [{ label: "A", callback_id: "a" }],
      [{ label: "B", callback_id: "b" }],
    ]);
    expect(kb.inline_keyboard.length).toBe(2);
    expect(kb.inline_keyboard[0][0]).toMatchObject({ text: "A", callback_data: "ai:a" });
    expect(kb.inline_keyboard[1][0]).toMatchObject({ text: "B", callback_data: "ai:b" });
  });
});

describe("buttons: findButtonLabel", () => {
  test("finds matching button label", () => {
    const kb = [
      [{ text: "Yes", callback_data: "ai:yes" }, { text: "No", callback_data: "ai:no" }],
    ];
    expect(findButtonLabel(kb, "ai:no")).toBe("No");
    expect(findButtonLabel(kb, "ai:yes")).toBe("Yes");
  });

  test("returns undefined when not found", () => {
    const kb = [[{ text: "Yes", callback_data: "ai:yes" }]];
    expect(findButtonLabel(kb, "ai:no")).toBeUndefined();
  });

  test("returns undefined when keyboard is undefined", () => {
    expect(findButtonLabel(undefined, "ai:yes")).toBeUndefined();
  });

  test("skips buttons without text or callback_data", () => {
    const kb = [[{ text: "Yes" }, { callback_data: "ai:no" }]];
    expect(findButtonLabel(kb, "ai:no")).toBeUndefined();
    expect(findButtonLabel(kb, "ai:yes")).toBeUndefined();
  });
});

describe("buttons: AI_CALLBACK_PREFIX", () => {
  test("is the canonical prefix", () => {
    expect(AI_CALLBACK_PREFIX).toBe("ai:");
  });
});
