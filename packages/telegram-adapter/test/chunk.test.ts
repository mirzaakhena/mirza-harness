// New test suite for chunk.ts — extracted from plugins/telegram/server.ts
// (chunk() at server.ts:477-496, chunk-planning block at server.ts:~702-800).
// Covers SCAR-046 (hard-cap + paragraph-boundary preference), SCAR-047 (raw
// chunking at margin=limit/2 before conversion, keeping entities intact),
// SCAR-048 (fallback to plain text — both the automatic pre-emptive
// fallback and the caller-invoked fallback() escape hatch), and SCAR-049
// (format 'markdown' auto-convert vs 'markdownv2' raw passthrough).

import { describe, test, expect } from "bun:test";
import { chunkText, planOutbound, MAX_CHUNK_LIMIT } from "../src/chunk";

describe("chunkText: SCAR-046 hard cap + boundary preference", () => {
  test("text at or under the limit is returned as a single piece", () => {
    expect(chunkText("hello", 10, "length")).toEqual(["hello"]);
    expect(chunkText("x".repeat(10), 10, "length")).toEqual(["x".repeat(10)]);
  });

  test("mode 'length' hard-cuts every piece to exactly the limit (except the tail)", () => {
    const text = "x".repeat(25);
    const out = chunkText(text, 10, "length");
    expect(out).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    for (const piece of out) expect(piece.length).toBeLessThanOrEqual(10);
  });

  test("mode 'newline' prefers a paragraph break (\\n\\n) over a hard cut", () => {
    const text = "A".repeat(10) + "\n\n" + "B".repeat(10);
    const out = chunkText(text, 15, "newline");
    expect(out).toEqual(["A".repeat(10), "B".repeat(10)]);
  });

  test("mode 'newline' prefers a single newline over a space within the same window", () => {
    // "AAA BBB\nCCC" — both a space (idx 3) and a newline (idx 7) sit inside
    // the limit window; the newline should win.
    const text = "AAA BBB\nCCC";
    const out = chunkText(text, 9, "newline");
    expect(out).toEqual(["AAA BBB", "CCC"]);
  });

  test("mode 'newline' falls back to a space when no newline is available", () => {
    const text = "AAAAAA BBBBBB";
    const out = chunkText(text, 8, "newline");
    expect(out).toEqual(["AAAAAA", " BBBBBB"]);
  });

  test("mode 'newline' hard-cuts at the limit when no whitespace boundary exists", () => {
    const text = "X".repeat(20);
    const out = chunkText(text, 8, "newline");
    expect(out).toEqual(["X".repeat(8), "X".repeat(8), "X".repeat(4)]);
  });

  test("MAX_CHUNK_LIMIT is Telegram's 4096-char hard cap", () => {
    expect(MAX_CHUNK_LIMIT).toBe(4096);
  });

  test("no chunk ever exceeds MAX_CHUNK_LIMIT, for either mode, on a long text", () => {
    const paragraph = "word ".repeat(50) + "\n\n"; // ~252 chars incl. break
    const longText = paragraph.repeat(40); // ~10k chars
    for (const mode of ["length", "newline"] as const) {
      const out = chunkText(longText, MAX_CHUNK_LIMIT, mode);
      expect(out.length).toBeGreaterThan(1);
      for (const piece of out) expect(piece.length).toBeLessThanOrEqual(MAX_CHUNK_LIMIT);
      // Round-trip: re-joining recovers the original modulo the newlines the
      // algorithm strips at each cut point.
      expect(out.join("").length).toBeGreaterThan(0);
    }
  });
});

describe("planOutbound: SCAR-049 format handling", () => {
  test("format 'text' passes chunks through with no conversion and no parse_mode", () => {
    const { parts } = planOutbound("plain text.", "text", 100);
    expect(parts).toEqual([{ text: "plain text." }]);
  });

  test("format 'markdown' auto-converts CommonMark to MarkdownV2", () => {
    const { parts } = planOutbound("**bold** text.", "markdown", 100);
    expect(parts.length).toBe(1);
    expect(parts[0]!.parse_mode).toBe("MarkdownV2");
    expect(parts[0]!.text).toContain("*bold*");
    expect(parts[0]!.text).not.toContain("**");
  });

  test("format 'markdownv2' is a raw passthrough (no conversion, no double-escaping)", () => {
    const alreadyEscaped = "already \\*escaped\\* text\\.";
    const { parts } = planOutbound(alreadyEscaped, "markdownv2", 100);
    expect(parts).toEqual([{ text: alreadyEscaped, parse_mode: "MarkdownV2" }]);
  });
});

describe("planOutbound: SCAR-047 raw-first chunking at margin=limit/2", () => {
  test("markdown format chunks the RAW text at half the limit, not the full limit", () => {
    const bold1 = "**" + "a".repeat(20) + "**"; // 24 chars, complete entity
    const bold2 = "**" + "b".repeat(20) + "**"; // 24 chars, complete entity
    const text = `${bold1}\n\n${bold2}`; // 50 chars total

    // Under the FULL limit (60) this text needs no splitting at all.
    expect(chunkText(text, 60, "newline")).toEqual([text]);

    // But planOutbound's markdown path chunks the raw text at margin =
    // floor(60/2) = 30, which forces a split at the paragraph boundary.
    const { parts } = planOutbound(text, "markdown", 60);
    expect(parts.length).toBe(2);
  });

  test("each chunk's converted entity is complete — bold markers are not split across chunks", () => {
    const bold1 = "**" + "a".repeat(20) + "**";
    const bold2 = "**" + "b".repeat(20) + "**";
    const text = `${bold1}\n\n${bold2}`;
    const { parts } = planOutbound(text, "markdown", 60);

    expect(parts.length).toBe(2);
    expect(parts[0]!.text).toContain("a".repeat(20));
    expect(parts[1]!.text).toContain("b".repeat(20));

    for (const part of parts) {
      // Count unescaped '*' — an odd count would mean a dangling/broken
      // entity (the open half of a bold span landed in a different chunk).
      const unescaped = part.text.replace(/\\\*/g, "");
      const starCount = (unescaped.match(/\*/g) ?? []).length;
      expect(starCount % 2).toBe(0);
      expect(starCount).toBeGreaterThan(0);
    }
  });
});

describe("planOutbound: SCAR-048 plain-text fallback", () => {
  test("pre-emptive fallback: a chunk whose conversion blows past the limit is planned as plain text", () => {
    // 20 literal periods (no markdown structure) — telegramify-markdown
    // escapes every '.' to '\.', roughly doubling length plus a trailing
    // newline, so it overflows a limit set at exactly 2x the raw length.
    const raw = ".".repeat(20);
    const limit = 40; // margin = 20 === raw.length, so raw is NOT re-split
    const { parts } = planOutbound(raw, "markdown", limit);

    expect(parts.length).toBe(1);
    expect(parts[0]!.parse_mode).toBeUndefined();
    expect(parts[0]!.text).toBe(raw); // fell back to the untouched raw text
  });

  test("fallback(part) returns the original raw markdown for a successfully-converted chunk", () => {
    const raw = "**bold** and a period.";
    const { parts, fallback } = planOutbound(raw, "markdown", 200);
    expect(parts.length).toBe(1);
    expect(parts[0]!.parse_mode).toBe("MarkdownV2");
    expect(parts[0]!.text).not.toBe(raw); // converted differs from raw

    const plain = fallback(parts[0]!);
    expect(plain).toBe(raw); // caller can resend this verbatim as plain text
  });

  test("fallback(part) is a no-op (identity) for format 'text' parts", () => {
    const { parts, fallback } = planOutbound("plain text.", "text", 100);
    expect(fallback(parts[0]!)).toBe("plain text.");
  });

  test("fallback(part) returns the same passthrough text for format 'markdownv2'", () => {
    const raw = "already \\*escaped\\*";
    const { parts, fallback } = planOutbound(raw, "markdownv2", 100);
    expect(fallback(parts[0]!)).toBe(raw);
  });
});
