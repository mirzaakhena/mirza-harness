// Ported from plugins/telegram/markdown.ts (mirza-marketplace), with FUNC-2 fix
// applied during porting (see wrapGfmTablesAsCodeBlocks below). Only
// import/style conventions adapted otherwise (semicolons, double quotes).

import telegramifyMarkdown from "telegramify-markdown";

/**
 * FUNC-2 fix: telegramify-markdown fails silently on GFM tables — it emits
 * the pipe/dash table syntax verbatim without escaping the MarkdownV2
 * special characters (`|`, `-`, `.` etc.) that appear in table cells and
 * separator rows. Telegram then rejects the message ("can't parse entities")
 * with no indication the table was the cause.
 *
 * Fix: pre-process the input — detect GFM table blocks (a header row
 * followed by a `---`/`:--:` separator row) that live outside existing
 * fenced code blocks, and wrap each one in a ``` fenced code block before
 * handing the text to telegramify-markdown. Inside a fence, MarkdownV2 only
 * requires escaping backslash/backtick, so the pipes and dashes survive
 * untouched and Telegram renders the table as monospace text instead of the
 * message failing to send.
 */
function isTableSeparatorRow(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

function isPotentialTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function wrapGfmTablesAsCodeBlocks(input: string): string {
  const lines = input.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }

    if (
      !inFence &&
      isPotentialTableRow(line) &&
      i + 1 < lines.length &&
      isTableSeparatorRow(lines[i + 1]!)
    ) {
      const tableLines = [line, lines[i + 1]!];
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim() !== "" && lines[j]!.includes("|")) {
        tableLines.push(lines[j]!);
        j++;
      }
      out.push("```");
      out.push(...tableLines);
      out.push("```");
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return out.join("\n");
}

/**
 * Convert a CommonMark-style string into Telegram MarkdownV2.
 *
 * The point is to free the AI from remembering MarkdownV2's escape rules
 * (every `. - ( ) ! +` etc. outside markup must be backslash-escaped or the
 * Telegram API rejects the message with HTTP 400). The AI writes normal
 * markdown — **bold**, *italic*, `inline code`, fenced code blocks, links —
 * and this function produces a string the server can hand to `sendMessage`
 * with `parse_mode: 'MarkdownV2'`.
 *
 * Backed by the `telegramify-markdown` package (remark-based). GFM tables are
 * pre-wrapped in code fences first — see wrapGfmTablesAsCodeBlocks (FUNC-2).
 */
export function commonMarkToMarkdownV2(input: string): string {
  // Library throws on empty/null in some versions — short-circuit defensively
  // so the reply tool doesn't surface a confusing error for an empty message.
  if (!input) return "";
  // "keep" matches the source plugin's behavior of calling the library with
  // no second argument (its untyped JS default) — pinned explicitly here to
  // satisfy this repo's strict tsc --noEmit, no behavior change intended.
  return telegramifyMarkdown(wrapGfmTablesAsCodeBlocks(input), "keep");
}
