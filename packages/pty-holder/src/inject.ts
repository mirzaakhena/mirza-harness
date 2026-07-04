/**
 * Pure pacing/splitting logic for typing into a PTY-hosted Claude Code
 * session. Kept free of any node-pty import so it stays unit-testable under
 * `bun:test` (pty.ts, which touches the native module, cannot load there —
 * see that file's docstring and the package README).
 *
 * Ported from `plugins/pty-controller/wrapper/src/wrapper.ts` (kode acuan)
 * `injectSlashCommand`/`injectText` (lines 594-628) and
 * `plugins/pty-controller/wrapper/src/prompt-inject.ts`'s `chunkPromptText`,
 * generalized behind the pty-holder IPC contract's two request shapes:
 * `inject {text, submit}` and `inject-slash {command, confirmAfterMs?}`.
 * pty.ts turns the `InjectStep[]` plans below into real `setTimeout` +
 * `pty.write` calls against a live PTY.
 */

/** Code points per write when typing a long body (SCAR-007/020). */
export const CHUNK_SIZE = 100;

/** Pause between chunk writes so Claude Code's TUI input drains before the
 * next slice lands — a single large write over Windows ConPTY overflows the
 * input buffer and silently drops the head, keeping only the tail
 * (SCAR-019). */
export const CHUNK_DELAY_MS = 30;

/**
 * Delay between writing text and the trailing submitting `\r` (SCAR-001/029).
 * Splitting into two writes mimics a human pause between typing and pressing
 * Enter — CC's autocomplete picker (for namespaced commands like
 * `/telegram:foo`) otherwise swallows a `\r` arriving in the same chunk as
 * the text instead of treating it as a top-level submit.
 */
export const SUBMIT_DELAY_MS = 250;

/** Bounds `inject-slash`'s optional `confirmAfterMs` is clamped into (SCAR-035). */
export const CONFIRM_AFTER_MS_MIN = 50;
export const CONFIRM_AFTER_MS_MAX = 5000;

/** One paced write: `text` should land `delayMs` after the plan starts. */
export interface InjectStep {
  readonly delayMs: number;
  readonly text: string;
}

/**
 * Split `text` into `size`-code-point slices (default `CHUNK_SIZE`).
 *
 * Splits on code points (`Array.from`), not UTF-16 units, so a chunk
 * boundary never bisects a surrogate pair — messages may contain emoji, and
 * a split surrogate would corrupt the stream. `chunks.join('')` always
 * reconstructs the input.
 */
export function chunkText(text: string, size: number = CHUNK_SIZE): string[] {
  const codePoints = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < codePoints.length; i += size) out.push(codePoints.slice(i, i + size).join(""));
  return out;
}

/** Clamp `ms` into `[CONFIRM_AFTER_MS_MIN, CONFIRM_AFTER_MS_MAX]` (SCAR-035). */
export function clampConfirmDelay(ms: number): number {
  return Math.min(CONFIRM_AFTER_MS_MAX, Math.max(CONFIRM_AFTER_MS_MIN, ms));
}

/**
 * Plan the paced writes for the `inject` request: type `text` in
 * `CHUNK_SIZE`-code-point slices, `CHUNK_DELAY_MS` apart, then — if
 * `submit` — a trailing `\r` write `SUBMIT_DELAY_MS` after the last chunk
 * lands.
 *
 * Mirrors kode acuan's `injectText` pacing exactly: `elapsed` advances by
 * `CHUNK_DELAY_MS` after EVERY chunk (including the last), and the final
 * `\r`'s delay is `elapsed + SUBMIT_DELAY_MS` — for empty text (no chunks)
 * this reduces to a bare `\r` at `SUBMIT_DELAY_MS`.
 */
export function planInject(text: string, submit: boolean): InjectStep[] {
  const chunks = chunkText(text, CHUNK_SIZE);
  const steps: InjectStep[] = [];
  let elapsed = 0;
  for (const chunk of chunks) {
    steps.push({ delayMs: elapsed, text: chunk });
    elapsed += CHUNK_DELAY_MS;
  }
  if (submit) steps.push({ delayMs: elapsed + SUBMIT_DELAY_MS, text: "\r" });
  return steps;
}

/**
 * Plan the paced writes for the `inject-slash` request: write `command` in
 * one shot (slash commands are short — no chunking needed), submit with a
 * `\r` after `SUBMIT_DELAY_MS`, and — if `confirmAfterMs` is given — a
 * SECOND `\r` a clamped `confirmAfterMs` after the first one lands (SCAR-035;
 * for commands that show a follow-up confirmation prompt needing another
 * Enter, e.g. a destructive-action y/n).
 */
export function planInjectSlash(command: string, confirmAfterMs?: number): InjectStep[] {
  const steps: InjectStep[] = [
    { delayMs: 0, text: command },
    { delayMs: SUBMIT_DELAY_MS, text: "\r" },
  ];
  if (confirmAfterMs !== undefined) {
    steps.push({ delayMs: SUBMIT_DELAY_MS + clampConfirmDelay(confirmAfterMs), text: "\r" });
  }
  return steps;
}
