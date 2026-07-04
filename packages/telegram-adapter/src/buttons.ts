// Ported 1:1 from plugins/telegram/buttons.ts (mirza-marketplace).
// Only import/style conventions adapted (semicolons, double quotes); logic untouched.
// Covers SCAR-052 (callback_id shape keeps callback_data payload well under
// Telegram's 64-byte limit once prefixed with "ai:").

import { InlineKeyboard } from "grammy";

const CALLBACK_ID_RE = /^[a-z0-9_]{1,32}$/;
const MAX_LABEL_LEN = 64;
const MAX_ROWS = 8;
const MAX_BUTTONS_PER_ROW = 8;

export const AI_CALLBACK_PREFIX = "ai:";

export type ButtonSpec = { label: string; callback_id: string };
export type ButtonRow = ButtonSpec[];

export type ValidateResult =
  | { ok: true; rows: ButtonRow[] }
  | { ok: false; error: string };

/**
 * Validate untyped JSON input as a buttons specification.
 * Shape: ButtonSpec[][] — outer array = rows, inner array = buttons in a row.
 *
 * Rules:
 *  - 1..8 rows, each with 1..8 buttons
 *  - label: non-empty string, max 64 chars
 *  - callback_id: matches /^[a-z0-9_]{1,32}$/
 *  - callback_id must be unique across the whole spec
 */
export function validateButtons(input: unknown): ValidateResult {
  if (!Array.isArray(input)) return { ok: false, error: "buttons must be an array of rows" };
  if (input.length === 0) return { ok: false, error: "buttons must contain at least one row" };
  if (input.length > MAX_ROWS) return { ok: false, error: `too many rows (max ${MAX_ROWS})` };

  const seenIds = new Set<string>();
  const rows: ButtonRow[] = [];

  for (let r = 0; r < input.length; r++) {
    const row = input[r];
    if (!Array.isArray(row)) return { ok: false, error: `row ${r} must be an array` };
    if (row.length === 0) return { ok: false, error: `row ${r} is empty` };
    if (row.length > MAX_BUTTONS_PER_ROW) {
      return { ok: false, error: `row ${r} has too many buttons (max ${MAX_BUTTONS_PER_ROW})` };
    }

    const parsedRow: ButtonRow = [];
    for (let c = 0; c < row.length; c++) {
      const btn = row[c] as Record<string, unknown> | null;
      if (typeof btn !== "object" || btn === null) {
        return { ok: false, error: `row ${r} col ${c}: button must be an object` };
      }
      const label = btn.label;
      const callback_id = btn.callback_id;

      if (typeof label !== "string" || label.length === 0) {
        return { ok: false, error: `row ${r} col ${c}: label must be a non-empty string` };
      }
      if (label.length > MAX_LABEL_LEN) {
        return { ok: false, error: `row ${r} col ${c}: label too long (max ${MAX_LABEL_LEN})` };
      }
      if (typeof callback_id !== "string") {
        return { ok: false, error: `row ${r} col ${c}: callback_id must be a string` };
      }
      if (!CALLBACK_ID_RE.test(callback_id)) {
        return {
          ok: false,
          error: `row ${r} col ${c}: callback_id "${callback_id}" must match /^[a-z0-9_]{1,32}$/`,
        };
      }
      if (seenIds.has(callback_id)) {
        return { ok: false, error: `duplicate callback_id "${callback_id}"` };
      }
      seenIds.add(callback_id);
      parsedRow.push({ label, callback_id });
    }
    rows.push(parsedRow);
  }

  return { ok: true, rows };
}

/**
 * Parse the data payload of an inline-button callback for AI-issued buttons.
 * Returns null if the payload is not an ai-namespace callback or is malformed.
 */
export function parseAiCallbackData(data: string): { callback_id: string } | null {
  if (!data.startsWith(AI_CALLBACK_PREFIX)) return null;
  const callback_id = data.slice(AI_CALLBACK_PREFIX.length);
  if (!CALLBACK_ID_RE.test(callback_id)) return null;
  return { callback_id };
}

/**
 * Build a grammy InlineKeyboard from validated button rows.
 * Each button's callback_data is prefixed with `ai:` for namespace isolation
 * from the permission flow (`perm:*`).
 */
export function buildKeyboard(rows: ButtonRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let r = 0; r < rows.length; r++) {
    for (const btn of rows[r]) {
      kb.text(btn.label, `${AI_CALLBACK_PREFIX}${btn.callback_id}`);
    }
    if (r < rows.length - 1) kb.row();
  }
  return kb;
}

/**
 * Find the button label whose callback_data matches the given payload, by
 * scanning the inline_keyboard structure of a Telegram message. Returns
 * undefined if not found (e.g., the original buttons were edited away).
 */
export function findButtonLabel(
  inlineKeyboard: ReadonlyArray<ReadonlyArray<{ text?: string; callback_data?: string }>> | undefined,
  callbackData: string,
): string | undefined {
  if (!inlineKeyboard) return undefined;
  for (const row of inlineKeyboard) {
    for (const btn of row) {
      if (btn.callback_data === callbackData && typeof btn.text === "string") {
        return btn.text;
      }
    }
  }
  return undefined;
}
