#!/usr/bin/env bun
/**
 * Task H4, Fase 2 — PreToolUse commit-trailer guard, tokenized.
 *
 * Replaces `plugins/bot-conduct/hooks/commit-trailer-guard.ts` (mirza-marketplace),
 * which had two known holes (recon-hooks.md §A, FUNC-4/5):
 *   - FUNC-4: matcher was `Bash` only — a PowerShell `git commit` sailed straight
 *     through. Fixed by matching `Bash|PowerShell` in hooks.json and reading the
 *     same `tool_input.command` field regardless of which tool fired.
 *   - FUNC-5: the old check was two regexes (`/\bgit\s+commit\b/` for "is this a
 *     commit" and `/^\s*Agent:\s*\S+/m` for "is there a trailer anywhere in the
 *     whole command string"). Both regexes were bypassable and both had
 *     false positives:
 *       - `-am "msg"` / `--message="msg"` never matched a plain `-m\b`-shaped
 *         assumption baked into some earlier guards, and more importantly the
 *         trailer regex only cared whether the STRING "Agent: x" appeared
 *         ANYWHERE in the command — `echo "Agent: bot-03" > notes.txt && git
 *         commit -m "fix"` would satisfy it despite the trailer never landing
 *         in the actual commit message.
 *       - `grep -m 1 "git commit" file` matched `/\bgit\s+commit\b/` as a
 *         literal substring even though no git process is invoked at all.
 *   - This version tokenizes the command (respecting '...' / "..." / PowerShell
 *     @'...'@ here-strings and && / || / ; / | / newline as command
 *     separators), only evaluates a segment whose FIRST token is literally
 *     `git` and which resolves to a `commit` subcommand (after skipping
 *     leading `-C <path>` / `-c k=v` global options), extracts the actual
 *     message content from -m/-am/-sm/--message[=]/-F/--trailer, and checks
 *     the trailer against THAT content only.
 *
 * Self-contained except for `resolveBotId` (src/tools.ts) — the same bot-id
 * resolution cc-stub's MCP tools use (MIRZA_BOT_ID env, else basename(cwd)),
 * so the trailer this hook demands is always the bot's own identity, not an
 * arbitrary "any Agent: line".
 */
import { readFileSync } from "node:fs";
import { resolveBotId } from "../src/tools";

// ---------------------------------------------------------------------------
// Tokenizer: split a shell/PowerShell command string into top-level segments
// (on && || ; | and newline, outside quotes), then split each segment into
// words (on whitespace, outside quotes), stripping quote delimiters and
// applying minimal backslash-escape handling inside double quotes (bash
// semantics: \" \\ \$ \` are escapes, anything else keeps the backslash
// literally — notably \n stays as the two literal characters "\" "n", which
// matters for the trailer check below).
// ---------------------------------------------------------------------------

const DOUBLE_QUOTE_ESCAPES = '"\\$`';

/**
 * `$'...'` is bash ANSI-C quoting, NOT the same as `'...'`: inside it, `\'` is
 * a literal quote (does not close the construct) and `\\` is a literal
 * backslash. Any other backslash sequence (e.g. `\n`) is left as the two
 * literal characters, same fallback rule as DOUBLE_QUOTE_ESCAPES above and
 * for the same reason (hasTrailer's `\n` normalization handles that later).
 * Treating `$'...'` like a plain `'...'` (as the old tokenizer did) lets a
 * `\'` inside it desync the quote-tracking: with no escape awareness, the
 * scanner sees `$'a\'` as already closed at the first `'`, then treats the
 * rest of the string up to the NEXT unescaped `'` as plain unquoted text —
 * or, if there is no other `'` at all, swallows the remainder of the command
 * whole, hiding e.g. `&& git commit -m "no trailer"` inside one opaque token
 * that never reaches findCommitArgs. Scanning `$'...'` with its own escape
 * semantics keeps the quote correctly balanced in that case.
 */
const DOLLAR_QUOTE_ESCAPES = "'\\";

interface DollarQuoteScan {
  /** Full matched text including delimiters (or, if unterminated, through end of string). */
  raw: string;
  /** Unescaped content (delimiters stripped, \' -> ', \\ -> \). */
  content: string;
  /** Index just past the match (== source.length if unterminated). */
  end: number;
  /** false if end-of-string was hit before an unescaped closing '. */
  terminated: boolean;
}

/** Scan a `$'...'` construct starting at `s[i]` (`s[i] === "$"`, `s[i+1] === "'"`). */
function scanDollarQuote(s: string, i: number): DollarQuoteScan {
  const n = s.length;
  let j = i + 2;
  let content = "";
  while (j < n) {
    if (s[j] === "\\" && j + 1 < n && DOLLAR_QUOTE_ESCAPES.includes(s[j + 1])) {
      content += s[j + 1];
      j += 2;
      continue;
    }
    if (s[j] === "'") {
      j += 1;
      return { raw: s.slice(i, j), content, end: j, terminated: true };
    }
    content += s[j];
    j += 1;
  }
  return { raw: s.slice(i, j), content, end: j, terminated: false };
}

interface TopLevelScan {
  segments: string[];
  /** true if any quote/here-string/`$'...'` construct never found its closing delimiter. */
  unbalanced: boolean;
}

function scanTopLevel(command: string): TopLevelScan {
  const segments: string[] = [];
  let cur = "";
  let i = 0;
  const n = command.length;
  let unbalanced = false;
  while (i < n) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end === -1 ? n : end + 1;
      if (end === -1) unbalanced = true;
      cur += command.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (command[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (command[j] === '"') {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) unbalanced = true;
      cur += command.slice(i, j);
      i = j;
      continue;
    }
    if (command.startsWith("$'", i)) {
      const scan = scanDollarQuote(command, i);
      if (!scan.terminated) unbalanced = true;
      cur += scan.raw;
      i = scan.end;
      continue;
    }
    if (command.startsWith("@'", i)) {
      const end = command.indexOf("'@", i + 2);
      const stop = end === -1 ? n : end + 2;
      if (end === -1) unbalanced = true;
      cur += command.slice(i, stop);
      i = stop;
      continue;
    }
    // Bash line-continuation: an unquoted `\` immediately followed by a
    // newline (LF or CRLF) is NOT a literal backslash and must not be
    // mistaken for the end of a segment — `git commit \<LF>  -m "..."` is a
    // SINGLE `git commit -m "..."` invocation once bash splices the line,
    // not a bare `git commit` (allowed) followed by a stray `-m "..."`
    // segment (never checked). Collapse the pair to a single space instead
    // of treating either character as content or as a separator. This only
    // applies at top level and inside "..." (see the tokenizeWords mirror
    // below) — inside '...' the backslash is literal, and inside $'...' it
    // follows that construct's own escape rules (scanDollarQuote), so those
    // spans are already consumed whole above and never reach this branch. A
    // plain `\` NOT followed by a newline (e.g. a Windows path `C:\Users`,
    // or an escaped `\\`) falls through unchanged to the default case below.
    if (ch === "\\" && command[i + 1] === "\r" && command[i + 2] === "\n") {
      cur += " ";
      i += 3;
      continue;
    }
    if (ch === "\\" && command[i + 1] === "\n") {
      cur += " ";
      i += 2;
      continue;
    }
    // PowerShell line-continuation: an unquoted backtick (`` ` ``) immediately
    // followed by a newline (LF or CRLF) is PowerShell's line-splice token —
    // this fleet's primary shell is PowerShell (FUNC-4), so `git commit `<LF>
    // -m "..."` is a SINGLE invocation once PowerShell splices the line, same
    // as the bash `\`+newline case just above. Collapse the pair to a single
    // space for the same reason: otherwise the backtick is swallowed as inert
    // trailing content on a bare `git commit` (allowed) and the real `-m
    // "..."` arg becomes an unchecked stray segment. In bash, a backtick is
    // command-substitution syntax (`` `cmd` ``) rather than a continuation
    // token, but this tokenizer already doesn't model `$(...)`/backtick
    // command-substitution at all (accepted, documented limitation — see
    // module docstring), so collapsing a standalone backtick+newline here
    // doesn't regress any bash behavior this guard actually relies on. NB: a
    // consequence is that a multi-line BASH backtick command-substitution that
    // wraps `git commit` now also bypasses (same class as `$(...)`, which never
    // matched in any version) — an unrealistic path for a real commit, listed
    // among the accepted command-substitution limitations. A
    // backtick NOT immediately followed by a newline (mid-text, e.g. a
    // Markdown code span) falls through unchanged to the default case below.
    if (ch === "`" && command[i + 1] === "\r" && command[i + 2] === "\n") {
      cur += " ";
      i += 3;
      continue;
    }
    if (ch === "`" && command[i + 1] === "\n") {
      cur += " ";
      i += 2;
      continue;
    }
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      segments.push(cur);
      cur = "";
      i += 2;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      segments.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  segments.push(cur);
  return { segments, unbalanced };
}

/** Split on top-level && || ; | and newline, respecting '...' "..." $'...' and @'...'@. */
export function splitTopLevel(command: string): string[] {
  return scanTopLevel(command).segments;
}

/**
 * true if `command` contains a quote/here-string/`$'...'` construct that
 * never closes before end-of-string. When this happens, the tokenizer cannot
 * reliably know where that construct — and therefore the rest of the command
 * — actually ends; see checkCommit's safety net below.
 */
export function hasUnbalancedQuote(command: string): boolean {
  return scanTopLevel(command).unbalanced;
}

/** Split a single segment into words, respecting quotes/here-strings and unescaping. */
export function tokenizeWords(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let curHasContent = false;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (curHasContent) {
        tokens.push(cur);
        cur = "";
        curHasContent = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = segment.indexOf("'", i + 1);
      const stop = end === -1 ? n : end;
      cur += segment.slice(i + 1, stop);
      i = end === -1 ? n : end + 1;
      curHasContent = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        // Same line-continuation collapse as scanTopLevel above, mirrored
        // here because a segment's "..." span reaches this loop still
        // containing its raw `\<newline>` (scanTopLevel copies quoted spans
        // verbatim, it doesn't rewrite their insides) — e.g. -m "line1 \<LF>
        // line2 Agent: bot-03" must read as one continuous message, not as
        // "line1 \" followed by a stray literal newline. Must be checked
        // before the DOUBLE_QUOTE_ESCAPES branch below (that branch only
        // recognizes \" \\ \$ \` and would otherwise leave the backslash in
        // place while still consuming the following char).
        if (segment[j] === "\\" && segment[j + 1] === "\r" && segment[j + 2] === "\n") {
          buf += " ";
          j += 3;
          continue;
        }
        if (segment[j] === "\\" && segment[j + 1] === "\n") {
          buf += " ";
          j += 2;
          continue;
        }
        // Mirror of the PowerShell backtick+newline collapse in scanTopLevel
        // above, for the same reason the bash `\`+newline mirror exists just
        // above it: a segment's "..." span reaches this loop still containing
        // its raw `` ` ``<newline>, e.g. -m "line1 `<LF> line2 Agent: bot-03"
        // must read as one continuous message. Checked before the plain
        // backtick would otherwise just fall through as a literal character.
        if (segment[j] === "`" && segment[j + 1] === "\r" && segment[j + 2] === "\n") {
          buf += " ";
          j += 3;
          continue;
        }
        if (segment[j] === "`" && segment[j + 1] === "\n") {
          buf += " ";
          j += 2;
          continue;
        }
        if (segment[j] === "\\" && j + 1 < n && DOUBLE_QUOTE_ESCAPES.includes(segment[j + 1])) {
          buf += segment[j + 1];
          j += 2;
          continue;
        }
        if (segment[j] === '"') {
          j += 1;
          break;
        }
        buf += segment[j];
        j += 1;
      }
      cur += buf;
      i = j;
      curHasContent = true;
      continue;
    }
    if (segment.startsWith("@'", i)) {
      const end = segment.indexOf("'@", i + 2);
      const stop = end === -1 ? n : end;
      cur += segment.slice(i + 2, stop);
      i = end === -1 ? n : end + 2;
      curHasContent = true;
      continue;
    }
    if (segment.startsWith("$'", i)) {
      const scan = scanDollarQuote(segment, i);
      cur += scan.content;
      i = scan.end;
      curHasContent = true;
      continue;
    }
    cur += ch;
    curHasContent = true;
    i += 1;
  }
  if (curHasContent) tokens.push(cur);
  return tokens;
}

/**
 * If `tokens` is a `git [global-opts] commit ...` invocation (first token
 * literally "git", optionally followed by `-C <path>` / `-c k=v` global
 * options, then the `commit` subcommand), return the remaining args after
 * `commit`. Otherwise return `null` — this segment isn't a commit invocation
 * (wrong executable, e.g. `grep`, or a different git subcommand, e.g. `git
 * push`) and must be allowed without further inspection.
 */
export function findCommitArgs(tokens: string[]): string[] | null {
  if (tokens.length === 0 || tokens[0] !== "git") return null;
  let idx = 1;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === "-C" || t === "-c") {
      idx += 2;
      continue;
    }
    if ((t.startsWith("-C") || t.startsWith("-c")) && t.length > 2) {
      idx += 1;
      continue;
    }
    break;
  }
  if (tokens[idx] !== "commit") return null;
  return tokens.slice(idx + 1);
}

/** A short flag combo like -am / -sm counts as carrying -m (message follows as the next arg). */
function isCombinedShortMessageFlag(arg: string): boolean {
  return arg !== "-m" && /^-[A-Za-z]{2,}$/.test(arg) && arg.endsWith("m");
}

export interface MessageExtraction {
  /** true if -m/-am/-sm/--message[=]/-F/--file[=]/--trailer[=] appeared at all. */
  sawMessageFlag: boolean;
  /** Joined message content (all -m/-F/--trailer parts, newline-joined). */
  message: string;
  /** Set when a -F/--file file couldn't be read — block conservatively with this reason. */
  fileError?: string;
}

/** Extract the actual commit-message content from a commit's args (after the `commit` token). */
export function extractMessage(args: string[]): MessageExtraction {
  const parts: string[] = [];
  let sawMessageFlag = false;
  let fileError: string | undefined;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "-m" || isCombinedShortMessageFlag(a)) {
      sawMessageFlag = true;
      const val = args[i + 1];
      if (val !== undefined) parts.push(val);
      i += 2;
      continue;
    }
    if (a === "--message") {
      sawMessageFlag = true;
      const val = args[i + 1];
      if (val !== undefined) parts.push(val);
      i += 2;
      continue;
    }
    if (a.startsWith("--message=")) {
      sawMessageFlag = true;
      parts.push(a.slice("--message=".length));
      i += 1;
      continue;
    }
    if (a === "-F" || a === "--file") {
      sawMessageFlag = true;
      const path = args[i + 1];
      i += 2;
      if (path === undefined) {
        fileError = "commit -F/--file tanpa argumen path — tidak bisa memverifikasi trailer, block konservatif.";
        continue;
      }
      try {
        parts.push(readFileSync(path, "utf8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fileError = `commit -F/--file ${path}: file tidak dapat dibaca (${msg}) — tidak bisa memverifikasi trailer, block konservatif.`;
      }
      continue;
    }
    if (a.startsWith("--file=")) {
      sawMessageFlag = true;
      const path = a.slice("--file=".length);
      i += 1;
      try {
        parts.push(readFileSync(path, "utf8"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fileError = `commit --file=${path}: file tidak dapat dibaca (${msg}) — tidak bisa memverifikasi trailer, block konservatif.`;
      }
      continue;
    }
    if (a === "--trailer") {
      sawMessageFlag = true;
      const val = args[i + 1];
      if (val !== undefined) parts.push(val);
      i += 2;
      continue;
    }
    if (a.startsWith("--trailer=")) {
      sawMessageFlag = true;
      parts.push(a.slice("--trailer=".length));
      i += 1;
      continue;
    }
    i += 1;
  }
  return { sawMessageFlag, message: parts.join("\n"), fileError };
}

/**
 * Does `message` carry an `Agent: <botId>` trailer line? Literal "\n"
 * (backslash + n, two characters — what you get typing a multi-line message
 * inside plain double quotes without shell-level interpretation) is
 * normalized to a real newline first, so a message built as
 * `"line one\n\nAgent: bot-03"` is recognized the same as an actual
 * multi-line string.
 */
export function hasTrailer(message: string, botId: string): boolean {
  const normalized = message.replace(/\\n/g, "\n");
  const re = /^[ \t]*Agent:\s*(\S+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    if (m[1] === botId) return true;
  }
  return false;
}

export interface CommitCheckResult {
  deny: boolean;
  reason?: string;
}

/**
 * Full check: does `command` contain a `git ... commit` invocation whose
 * actual message content lacks an `Agent: <botId>` trailer? Non-commit
 * commands (wrong executable, `git status`/`git push`, a `commit` subcommand
 * with no inspectable message flag at all e.g. `--amend --no-edit`) are
 * allowed without inspection. Compound commands (`a && b`, `a; b`, `a | b`)
 * are split and each segment checked independently; the first offending
 * commit invocation is reported.
 */
export function checkCommit(command: string, botId: string): CommitCheckResult {
  for (const segment of splitTopLevel(command)) {
    const tokens = tokenizeWords(segment);
    const args = findCommitArgs(tokens);
    if (args === null) continue; // not a git commit invocation in this segment

    const { sawMessageFlag, message, fileError } = extractMessage(args);
    if (fileError) return { deny: true, reason: fileError };
    if (!sawMessageFlag) continue; // e.g. `git commit --amend --no-edit` — message unchanged, allow

    if (!hasTrailer(message, botId)) {
      return {
        deny: true,
        reason:
          `bot-conduct requires an "Agent: ${botId}" trailer line in the actual commit message body ` +
          `(not merely somewhere in the command). Add it, e.g. -m "...your message...\n\nAgent: ${botId}", and retry.`,
      };
    }
  }

  // Safety net: every quote/here-string construct we know about (', ", $'...',
  // @'...'@) is scanned with its own escape rules above, so a well-formed
  // command never reaches here unbalanced. But if `command` still contains a
  // construct that never closes before end-of-string — a genuinely malformed
  // command, or a construct/escape rule we don't model — the tokenizer cannot
  // say where that construct (and therefore the rest of the command) actually
  // ends, so the loop above may never have seen a `git ... commit` segment
  // that's really there, swallowed into the unterminated blob. Fail closed
  // ONLY when that ambiguity coincides with textual evidence of a commit
  // (`git` and `commit` both present somewhere): a command with no trace of
  // either is allowed regardless of quote balance, since there's nothing to
  // hide.
  if (hasUnbalancedQuote(command) && command.includes("git") && command.includes("commit")) {
    return {
      deny: true,
      reason: "quote tak seimbang — tidak bisa memverifikasi trailer",
    };
  }

  return { deny: false };
}

// ---------------------------------------------------------------------------
// PreToolUse entrypoint (Bash | PowerShell — see hooks.json's matcher).
// ---------------------------------------------------------------------------

const HANDLED_TOOLS = new Set(["Bash", "PowerShell"]);

function main(): void {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return;
  }
  let input: any;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!HANDLED_TOOLS.has(input?.tool_name)) return;
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return;

  // NOTE: the two try/catches above (unreadable stdin, unparseable JSON) fail
  // OPEN — they `return` with no output, i.e. allow — because a malformed or
  // irrelevant hook payload isn't something this guard can or should block on.
  // The block below is the opposite, deliberately: if checkCommit/resolveBotId
  // themselves throw, that's a bug in the guard itself, not in the input, and
  // we'd rather wrongly deny a legitimate commit than silently let an
  // unverified one through. This fail-CLOSED choice is intentional and
  // differs from the fail-open pattern above.
  try {
    const botId = resolveBotId();
    const result = checkCommit(command, botId);
    if (!result.deny) return;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: result.reason,
        },
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `trailer-guard internal error: ${msg}`,
        },
      }),
    );
  }
}

if (import.meta.main) main();
