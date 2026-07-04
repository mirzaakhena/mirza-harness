import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommit, splitTopLevel, tokenizeWords, findCommitArgs, hasTrailer } from "../hooks/trailer-guard";

const BOT = "bot-03";

describe("checkCommit — old bypasses (FUNC-5) must now be caught", () => {
  test("git commit -am \"msg\" with no trailer -> block", () => {
    const r = checkCommit('git commit -am "msg"', BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/Agent: bot-03/);
  });

  test('git commit --message="msg" with no trailer -> block', () => {
    const r = checkCommit('git commit --message="msg"', BOT);
    expect(r.deny).toBe(true);
  });

  test("git commit --message msg (space form) with no trailer -> block", () => {
    const r = checkCommit("git commit --message msg", BOT);
    expect(r.deny).toBe(true);
  });

  test("git commit -sm \"msg\" with no trailer -> block", () => {
    const r = checkCommit('git commit -sm "msg"', BOT);
    expect(r.deny).toBe(true);
  });

  test("PowerShell-style invocation with no trailer -> block (matcher covers PowerShell too)", () => {
    // The hook itself dispatches on tool_name Bash|PowerShell before calling
    // checkCommit; checkCommit is tool-agnostic, so this exercises the same
    // command string a PowerShell tool_input.command would carry.
    const r = checkCommit('git commit -m "msg"', BOT);
    expect(r.deny).toBe(true);
  });
});

describe("checkCommit — old false positives (FUNC-4/5) must now pass", () => {
  test('grep -m 1 "git commit" file -> allow (not a git invocation at all)', () => {
    const r = checkCommit('grep -m 1 "git commit" file', BOT);
    expect(r.deny).toBe(false);
  });

  test("trailer written to a file, not into the commit message -> still blocks", () => {
    const r = checkCommit('echo "Agent: bot-03" > x && git commit -m "msg"', BOT);
    expect(r.deny).toBe(true);
  });

  test("trailer present in a second -m -> allow", () => {
    const r = checkCommit('git commit -m "msg" -m "Agent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test("git -C <path> commit -m with literal \\n\\n before trailer -> allow", () => {
    const r = checkCommit('git -C /some/path commit -m "x\\n\\nAgent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test("git -c user.name=x commit -m with trailer -> allow (global -c before subcommand)", () => {
    const r = checkCommit('git -c user.name=x commit -m "msg\n\nAgent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });
});

describe("checkCommit — $'...' (ANSI-C quoting) desync bypass must be caught", () => {
  test("reviewer PoC: echo $'a\\'b' && git commit with no trailer -> block (not allow)", () => {
    const r = checkCommit(`echo $'a\\'b' && git commit -m "no trailer"`, BOT);
    expect(r.deny).toBe(true);
  });

  test("same PoC with ; separator -> block", () => {
    const r = checkCommit(`echo $'a\\'b'; git commit -m "no trailer"`, BOT);
    expect(r.deny).toBe(true);
  });

  test("valid $'...' with no git commit anywhere -> allow", () => {
    const r = checkCommit(`echo $'a\\'b, escaped quote and all'`, BOT);
    expect(r.deny).toBe(false);
  });

  test("$'it\\'s ...' used as the commit message itself, WITH trailer -> allow (escape recognized correctly)", () => {
    const r = checkCommit(`git commit -m $'it\\'s a commit\\n\\nAgent: bot-03'`, BOT);
    expect(r.deny).toBe(false);
  });

  test("$'it\\'s ...' used as the commit message, WITHOUT trailer -> block", () => {
    const r = checkCommit(`git commit -m $'it\\'s a commit, no trailer'`, BOT);
    expect(r.deny).toBe(true);
  });

  test("genuinely unterminated quote + git commit present textually -> deny conservatively (safety net)", () => {
    const r = checkCommit(`echo 'unterminated && git commit -m "whatever"`, BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/quote tak seimbang/);
  });

  test("genuinely unterminated quote with no git/commit textually present -> allow (nothing to hide)", () => {
    const r = checkCommit(`echo 'unterminated and harmless`, BOT);
    expect(r.deny).toBe(false);
  });
});

describe("checkCommit — compound commit chains, both directions", () => {
  test('first commit has no trailer, second does -> block (first offender wins)', () => {
    const r = checkCommit('git commit -m "x" && git commit -m "y\\n\\nAgent: bot-03"', BOT);
    expect(r.deny).toBe(true);
  });

  test('first commit has trailer, second does not -> block', () => {
    const r = checkCommit('git commit -m "x\\n\\nAgent: bot-03" && git commit -m "y"', BOT);
    expect(r.deny).toBe(true);
  });

  test("both commits carry the trailer -> allow", () => {
    const r = checkCommit(
      'git commit -m "x\\n\\nAgent: bot-03" && git commit -m "y\\n\\nAgent: bot-03"',
      BOT,
    );
    expect(r.deny).toBe(false);
  });
});

describe("checkCommit — non-commit / no-message-flag commands are allowed", () => {
  test("git status -> allow", () => {
    expect(checkCommit("git status", BOT).deny).toBe(false);
  });

  test("git add -A -> allow", () => {
    expect(checkCommit("git add -A", BOT).deny).toBe(false);
  });

  test("git commit --amend --no-edit -> allow (message unchanged)", () => {
    expect(checkCommit("git commit --amend --no-edit", BOT).deny).toBe(false);
  });

  test("bare git commit (would open an editor) -> allow", () => {
    expect(checkCommit("git commit", BOT).deny).toBe(false);
  });

  test("unrelated bash -> allow", () => {
    expect(checkCommit("ls -la && echo hi", BOT).deny).toBe(false);
  });
});

describe("checkCommit — -F/--file", () => {
  const dir = mkdtempSync(join(tmpdir(), "trailer-guard-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("-F <file> with trailer inside -> allow", () => {
    const p = join(dir, "msg-with-trailer.txt");
    writeFileSync(p, "feat: thing\n\nAgent: bot-03\n");
    const r = checkCommit(`git commit -F ${p}`, BOT);
    expect(r.deny).toBe(false);
  });

  test("-F <file> without trailer inside -> block", () => {
    const p = join(dir, "msg-without-trailer.txt");
    writeFileSync(p, "feat: thing\n");
    const r = checkCommit(`git commit -F ${p}`, BOT);
    expect(r.deny).toBe(true);
  });

  test("-F <missing-file> -> block conservatively with a clear reason", () => {
    const p = join(dir, "does-not-exist.txt");
    const r = checkCommit(`git commit -F ${p}`, BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/tidak dapat dibaca/);
  });
});

describe("checkCommit — --trailer flag", () => {
  test("--trailer Agent:bot-03 counts as a valid trailer", () => {
    const r = checkCommit('git commit -m "msg" --trailer "Agent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test("--trailer for a different bot does not satisfy this bot's guard", () => {
    const r = checkCommit('git commit -m "msg" --trailer "Agent: bot-99"', BOT);
    expect(r.deny).toBe(true);
  });
});

describe("tokenizer building blocks", () => {
  test("splitTopLevel splits on && ; | and newline, not inside quotes", () => {
    expect(splitTopLevel("a && b")).toEqual(["a ", " b"]);
    expect(splitTopLevel('echo "a && b"')).toEqual(['echo "a && b"']);
    expect(splitTopLevel("a; b | c")).toEqual(["a", " b ", " c"]);
  });

  test("tokenizeWords strips quotes and joins mid-word quoting", () => {
    expect(tokenizeWords('--message="msg"')).toEqual(["--message=msg"]);
    expect(tokenizeWords("git commit -m 'hello world'")).toEqual(["git", "commit", "-m", "hello world"]);
  });

  test("tokenizeWords supports a minimal PowerShell here-string @'...'@", () => {
    expect(tokenizeWords("git commit -m @'multi\nline'@")).toEqual(["git", "commit", "-m", "multi\nline"]);
  });

  test("findCommitArgs recognizes -C/-c global opts before commit, and rejects other subcommands", () => {
    expect(findCommitArgs(["git", "commit", "-m", "x"])).toEqual(["-m", "x"]);
    expect(findCommitArgs(["git", "-C", "/p", "commit", "-m", "x"])).toEqual(["-m", "x"]);
    expect(findCommitArgs(["git", "push"])).toBeNull();
    expect(findCommitArgs(["grep", "-m", "1", "git commit", "file"])).toBeNull();
  });

  test("hasTrailer matches only the exact bot id, normalizing literal \\n", () => {
    expect(hasTrailer("hi\n\nAgent: bot-03", "bot-03")).toBe(true);
    expect(hasTrailer("hi\\n\\nAgent: bot-03", "bot-03")).toBe(true);
    expect(hasTrailer("hi\n\nAgent: bot-99", "bot-03")).toBe(false);
    expect(hasTrailer("Agent: bot-03-extra", "bot-03")).toBe(false);
  });
});

describe("checkCommit — bash line-continuation (\\<newline>) regression (pass 2)", () => {
  // Reviewer PoC: bash splices an unquoted `\` + newline into nothing before
  // running the command, so `git commit \<LF>  -m "no trailer"` is a SINGLE
  // `git commit -m "no trailer"` invocation, not a bare `git commit` (allowed)
  // followed by a stray `-m "no trailer"` segment (first token isn't `git`,
  // never inspected). The old guard's regex-based check happened to catch
  // this; scanTopLevel's newline-as-separator rule reintroduced the hole.
  test('git commit \\<LF>  -m "no trailer" -> deny (LF continuation)', () => {
    const r = checkCommit('git commit \\\n  -m "no trailer"', BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/Agent: bot-03/);
  });

  test('git commit \\<CRLF>  -m "no trailer" -> deny (CRLF continuation)', () => {
    const r = checkCommit('git commit \\\r\n  -m "no trailer"', BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/Agent: bot-03/);
  });

  test('git commit \\<LF>  -m "msg" \\<LF>  -m "Agent: bot-03" -> allow (trailer in continued second -m)', () => {
    const r = checkCommit('git commit \\\n  -m "msg" \\\n  -m "Agent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test('continuation in the middle of a -m value does not corrupt a later, real trailer line -> allow', () => {
    // Raw command bash actually sees (backslash-newline splices the first
    // two lines into one; the following blank line is a REAL, unescaped
    // newline so the trailer still lands on its own line):
    //   git commit -m "part1 \
    //   part2
    //
    //   Agent: bot-03"
    const r = checkCommit('git commit -m "part1 \\\npart2\n\nAgent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test("no regression: Windows path backslash (not followed by newline) stays literal", () => {
    expect(tokenizeWords('git commit -m "C:\\Users\\foo"')).toEqual([
      "git",
      "commit",
      "-m",
      "C:\\Users\\foo",
    ]);
    // Not a trailer, no continuation involved -> still blocked on its own merits.
    expect(checkCommit('git commit -m "C:\\Users\\foo"', BOT).deny).toBe(true);
  });

  test("no regression: escaped backslash \\\\ inside double quotes still unescapes to one literal backslash", () => {
    expect(tokenizeWords('git commit -m "a\\\\b"')).toEqual(["git", "commit", "-m", "a\\b"]);
  });

  test("no regression: backslash+newline literal inside single quotes is NOT collapsed (single quotes have no escapes)", () => {
    expect(tokenizeWords("git commit -m 'a\\\nb'")).toEqual(["git", "commit", "-m", "a\\\nb"]);
  });
});

describe("checkCommit — PowerShell backtick-continuation (`<newline>) regression (pass 3)", () => {
  // Reviewer PoC: PowerShell is this fleet's PRIMARY shell (FUNC-4), and in
  // PowerShell an unquoted backtick immediately followed by a newline is the
  // line-continuation token (like `\` in bash) — PowerShell splices it into
  // nothing before running the command. So `git commit `<LF>  -m "no
  // trailer"` is a SINGLE `git commit -m "no trailer"` invocation, not a bare
  // `git commit` (allowed) followed by a stray `-m "no trailer"` segment that
  // never gets inspected. Same shape of bug as the bash `\`+newline hole
  // fixed in pass 2, mirrored here for backtick.
  test('git commit `<LF>  -m "no trailer" -> deny (LF continuation)', () => {
    const r = checkCommit('git commit `\n  -m "no trailer"', BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/Agent: bot-03/);
  });

  test('git commit `<CRLF>  -m "no trailer" -> deny (CRLF continuation)', () => {
    const r = checkCommit('git commit `\r\n  -m "no trailer"', BOT);
    expect(r.deny).toBe(true);
    expect(r.reason).toMatch(/Agent: bot-03/);
  });

  test('git commit `<LF>  -m "msg" `<LF>  -m "Agent: bot-03" -> allow (trailer in continued second -m)', () => {
    const r = checkCommit('git commit `\n  -m "msg" `\n  -m "Agent: bot-03"', BOT);
    expect(r.deny).toBe(false);
  });

  test("no regression: backtick NOT followed by newline (mid-text) stays literal", () => {
    expect(tokenizeWords('git commit -m "a `n b"')).toEqual(["git", "commit", "-m", "a `n b"]);
    // Not a trailer, no continuation involved -> still blocked on its own merits.
    expect(checkCommit('git commit -m "a `n b"', BOT).deny).toBe(true);
  });

  test("no regression: backtick+newline literal inside single quotes is NOT collapsed (single quotes have no escapes)", () => {
    expect(tokenizeWords("git commit -m 'a`\nb'")).toEqual(["git", "commit", "-m", "a`\nb"]);
  });

  test("no regression: backtick+newline literal inside $'...' is NOT collapsed ($'...' has its own escape rules, not PowerShell's)", () => {
    expect(tokenizeWords("git commit -m $'a`\nb'")).toEqual(["git", "commit", "-m", "a`\nb"]);
  });
});
