import { describe, expect, test } from "bun:test";
import {
  CHUNK_DELAY_MS,
  CHUNK_SIZE,
  CONFIRM_AFTER_MS_MAX,
  CONFIRM_AFTER_MS_MIN,
  SUBMIT_DELAY_MS,
  chunkText,
  clampConfirmDelay,
  planInject,
  planInjectSlash,
} from "../src/inject";

describe("chunkText", () => {
  test("empty string yields no chunks", () => {
    expect(chunkText("", 100)).toEqual([]);
  });

  test("shorter than the chunk size yields a single chunk", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  test("splits into multiple chunks of the given size", () => {
    expect(chunkText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  test("exact multiple of the chunk size leaves no empty trailing chunk", () => {
    const text = "abcdefgh"; // 8 chars, size 4
    const chunks = chunkText(text, 4);
    expect(chunks).toEqual(["abcd", "efgh"]);
    expect(chunks.join("")).toBe(text);
  });

  test("never splits a surrogate pair (emoji) at a chunk boundary", () => {
    // Each 😀 is 2 UTF-16 units but 1 code point. A naive String.slice(0,2)
    // chunking (UTF-16 units) would bisect the second emoji's surrogate pair.
    const text = "😀😀😀";
    const chunks = chunkText(text, 2);
    expect(chunks).toEqual(["😀😀", "😀"]);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      // A corrupted chunk (lone surrogate) round-trips through Array.from
      // differently than the original — this equality catches that.
      expect(chunk).toBe(Array.from(chunk).join(""));
    }
  });

  test("round-trips arbitrary text with emoji through join", () => {
    const text = "The quick brown 🦊 jumps over the lazy 🐶 — 1234567890".repeat(20);
    expect(chunkText(text, 100).join("")).toBe(text);
  });

  test("flag emoji (regional-indicator pair) round-trips and never has a lone surrogate at a chunk boundary", () => {
    // 🇺🇸 is two regional-indicator code points (U+1F1FA U+1F1F8), each
    // itself a surrogate pair, rendered as one glyph via the Unicode flag
    // mechanism (not a single code point, unlike 😀). A chunk boundary MAY
    // legally fall between the two indicators (that only splits the
    // rendered grapheme cluster, which chunkText never promised to
    // preserve) but must never bisect either indicator's own surrogate
    // pair — that's what corrupts the stream.
    const text = "🇺🇸".repeat(3);
    const chunks = chunkText(text, 3);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk).toBe(Array.from(chunk).join(""));
    }
  });

  test("ZWJ family emoji round-trips and never has a lone surrogate at a chunk boundary", () => {
    // 👨‍👩‍👧‍👦 is 7 code points (man, ZWJ, woman, ZWJ, girl, ZWJ, boy) joined
    // into one rendered glyph via zero-width joiners. Same guarantee as
    // above: boundaries may fall between component code points, but every
    // individual surrogate pair must stay intact and the full text must
    // reconstruct exactly via join.
    const zwj = "\u{200D}";
    const family = `\u{1F468}${zwj}\u{1F469}${zwj}\u{1F467}${zwj}\u{1F466}`; // 👨‍👩‍👧‍👦
    const text = `${family}${"x".repeat(5)}${family}`;
    const chunks = chunkText(text, 4);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk).toBe(Array.from(chunk).join(""));
    }
  });

  test("defaults to CHUNK_SIZE (100) code points", () => {
    const text = "x".repeat(250);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(CHUNK_SIZE);
    expect(chunks[2]!.length).toBe(50);
  });
});

describe("clampConfirmDelay", () => {
  test("passes values already inside the range through unchanged", () => {
    expect(clampConfirmDelay(1000)).toBe(1000);
  });

  test("clamps below the floor up to CONFIRM_AFTER_MS_MIN", () => {
    expect(clampConfirmDelay(0)).toBe(CONFIRM_AFTER_MS_MIN);
    expect(clampConfirmDelay(-500)).toBe(CONFIRM_AFTER_MS_MIN);
  });

  test("clamps above the ceiling down to CONFIRM_AFTER_MS_MAX", () => {
    expect(clampConfirmDelay(999_999)).toBe(CONFIRM_AFTER_MS_MAX);
  });

  test("boundary values pass through unchanged", () => {
    expect(clampConfirmDelay(CONFIRM_AFTER_MS_MIN)).toBe(CONFIRM_AFTER_MS_MIN);
    expect(clampConfirmDelay(CONFIRM_AFTER_MS_MAX)).toBe(CONFIRM_AFTER_MS_MAX);
  });
});

describe("planInject", () => {
  test("submit=false with short text: one chunk write, no trailing \\r", () => {
    expect(planInject("hello", false)).toEqual([{ delayMs: 0, text: "hello" }]);
  });

  test("submit=true with short text: chunk write then \\r at SUBMIT_DELAY_MS after it", () => {
    const steps = planInject("hello", true);
    expect(steps).toEqual([
      { delayMs: 0, text: "hello" },
      { delayMs: CHUNK_DELAY_MS + SUBMIT_DELAY_MS, text: "\r" },
    ]);
  });

  test("empty text with submit=true is a bare \\r at SUBMIT_DELAY_MS", () => {
    expect(planInject("", true)).toEqual([{ delayMs: SUBMIT_DELAY_MS, text: "\r" }]);
  });

  test("empty text with submit=false produces no steps at all", () => {
    expect(planInject("", false)).toEqual([]);
  });

  test("long text is paced CHUNK_DELAY_MS apart across chunk boundaries", () => {
    const text = "a".repeat(250); // -> 3 chunks of 100/100/50
    const steps = planInject(text, true);
    expect(steps).toEqual([
      { delayMs: 0, text: "a".repeat(100) },
      { delayMs: CHUNK_DELAY_MS, text: "a".repeat(100) },
      { delayMs: 2 * CHUNK_DELAY_MS, text: "a".repeat(50) },
      { delayMs: 3 * CHUNK_DELAY_MS + SUBMIT_DELAY_MS, text: "\r" },
    ]);
  });

  test("a chunk boundary never bisects a surrogate pair inside a real plan", () => {
    const text = "😀".repeat(3);
    const steps = planInject(text, false);
    const texts = steps.map(s => s.text);
    expect(texts.join("")).toBe(text);
    for (const t of texts) expect(t).toBe(Array.from(t).join(""));
  });
});

describe("planInjectSlash", () => {
  test("plain command: write then \\r at SUBMIT_DELAY_MS, no confirm step", () => {
    expect(planInjectSlash("/clear")).toEqual([
      { delayMs: 0, text: "/clear" },
      { delayMs: SUBMIT_DELAY_MS, text: "\r" },
    ]);
  });

  test("with confirmAfterMs inside the clamp range: adds a second \\r that many ms after the first", () => {
    const steps = planInjectSlash("/dangerous", 1000);
    expect(steps).toEqual([
      { delayMs: 0, text: "/dangerous" },
      { delayMs: SUBMIT_DELAY_MS, text: "\r" },
      { delayMs: SUBMIT_DELAY_MS + 1000, text: "\r" },
    ]);
  });

  test("confirmAfterMs below the floor is clamped up to CONFIRM_AFTER_MS_MIN", () => {
    const steps = planInjectSlash("/x", 1);
    expect(steps[2]).toEqual({ delayMs: SUBMIT_DELAY_MS + CONFIRM_AFTER_MS_MIN, text: "\r" });
  });

  test("confirmAfterMs above the ceiling is clamped down to CONFIRM_AFTER_MS_MAX", () => {
    const steps = planInjectSlash("/x", 999_999);
    expect(steps[2]).toEqual({ delayMs: SUBMIT_DELAY_MS + CONFIRM_AFTER_MS_MAX, text: "\r" });
  });
});
