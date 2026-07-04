// Extracted from plugins/telegram/server.ts (mirza-marketplace):
//   - chunkText() ports chunk() at server.ts:477-496 (renamed only).
//   - planOutbound() ports the chunk-planning block at server.ts:~702-800
//     (the `format === 'markdown'` branch of the `reply` tool handler).
// Turned into a standalone pure module — no network I/O, no grammy/access
// dependency. The caller (adapter's send layer) is responsible for actually
// calling bot.api.sendMessage per part and, on a MarkdownV2 parse-entity
// error, retrying with fallback(part) — mirroring server.ts's try/catch
// around bot.api.sendMessage.

import { commonMarkToMarkdownV2 } from "./markdown";

/** Telegram's hard message-length ceiling (SCAR-046). */
export const MAX_CHUNK_LIMIT = 4096;

export type ChunkMode = "length" | "newline";
export type ReplyFormat = "text" | "markdown" | "markdownv2";

/**
 * Split `text` into pieces no longer than `limit`.
 *
 * mode 'length': hard-cuts at exactly `limit` chars.
 * mode 'newline': prefers the last paragraph break (\n\n), then line break
 * (\n), then space, within the limit window; falls back to a hard cut at
 * `limit` if none of those are found past the halfway point.
 */
export function chunkText(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === "newline") {
      // Prefer the last double-newline (paragraph), then single newline,
      // then space. Fall back to hard cut.
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export interface OutboundPart {
  text: string;
  parse_mode?: "MarkdownV2";
}

export interface PlanOutboundResult {
  parts: OutboundPart[];
  /**
   * Given a part returned in `parts`, returns the plain-text (unconverted)
   * fallback to send instead — for use when the actual Telegram send throws
   * a "can't parse entities" MarkdownV2 error (SCAR-048). For format:'text'
   * or already-plain parts this simply returns the same text.
   */
  fallback: (part: OutboundPart) => string;
}

/**
 * Plan how to split+render `text` for a Telegram reply.
 *
 * format 'text': plain chunking via chunkText(text, limit, mode); no
 * parse_mode, no conversion.
 *
 * format 'markdownv2': raw passthrough chunked with chunkText(text, limit,
 * mode); caller is assumed to have already escaped MarkdownV2 themselves
 * (legacy path) — every part gets parse_mode 'MarkdownV2' (SCAR-049).
 *
 * format 'markdown': the auto-convert path. The RAW CommonMark is chunked
 * FIRST, against a margin of floor(limit/2) rather than the full limit, and
 * paragraph-boundary splitting ('newline' mode) is forced regardless of the
 * caller's chunk mode. Only after chunking is each raw piece converted to
 * MarkdownV2 individually (SCAR-047). This order matters: converting the
 * whole text before chunking can split a MarkdownV2 entity across the cut
 * (`*bold` opened in chunk 1, closed in chunk 2), which Telegram rejects.
 * Chunking the raw text at half the limit leaves headroom for escaping to
 * inflate the string without the converted chunk blowing past `limit`; if a
 * pathological escape blow-up still pushes a chunk over `limit`, that piece
 * is planned as plain text (no parse_mode) instead of failing (SCAR-048).
 */
export function planOutbound(
  text: string,
  format: ReplyFormat,
  limit: number,
  mode: ChunkMode = "length",
): PlanOutboundResult {
  const rawByPart = new WeakMap<OutboundPart, string>();
  let parts: OutboundPart[];

  if (format === "markdown") {
    const margin = Math.max(1, Math.floor(limit / 2));
    // Paragraph-boundary splitting keeps inline entities intact far more
    // often than a hard length cut, so force 'newline' here.
    parts = chunkText(text, margin, "newline").map(raw => {
      const converted = commonMarkToMarkdownV2(raw);
      const part: OutboundPart =
        converted.length <= limit ? { text: converted, parse_mode: "MarkdownV2" } : { text: raw };
      rawByPart.set(part, raw);
      return part;
    });
  } else {
    const mv2 = format === "markdownv2";
    parts = chunkText(text, limit, mode).map(t => {
      const part: OutboundPart = mv2 ? { text: t, parse_mode: "MarkdownV2" } : { text: t };
      rawByPart.set(part, t);
      return part;
    });
  }

  const fallback = (part: OutboundPart): string => rawByPart.get(part) ?? part.text;

  return { parts, fallback };
}
