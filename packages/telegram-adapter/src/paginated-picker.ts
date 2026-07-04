// Ported 1:1 from plugins/telegram/paginated-picker.ts (mirza-marketplace).
// Only import/style conventions adapted (semicolons, double quotes); logic untouched.

/**
 * Pure helper that renders one page of a Telegram inline-keyboard picker.
 *
 * Used by /switch, /delete, and /archive in meta-commands.ts. All three
 * pickers share the layout below. Keeping the renderer in one place avoids
 * drift between commands.
 *
 *   [session label …]      } up to MAX_SESSIONS_PER_PAGE single-cell rows
 *   …
 *   [⬅️ Prev] [📄 N/M] [Next ➡️]    nav row — Prev omitted on page 1,
 *                                    Next omitted on last page,
 *                                    whole row omitted when totalPages === 1.
 *   [❌ Cancel]                      always last row.
 *
 * The page indicator button uses a no-op callback (`<prefix>_page_noop`) —
 * tapping it acks silently in the callback handler.
 */

export const MAX_SESSIONS_PER_PAGE = 6;
const MAX_LABEL_CHARS = 60;

export interface PickerButton {
  label: string;
  callbackData: string;
}

export interface RenderPickerPageInput<S> {
  /** All sessions to paginate (full set, not pre-sliced). */
  sessions: ReadonlyArray<S>;
  /** 1-based requested page. Clamped to [1, totalPages]. */
  page: number;
  /** Callback prefix WITHOUT trailing underscore, e.g. `meta:switch`. */
  callbackPrefix: string;
  /** Callback for the cancel button row. */
  cancelCallback: string;
  /** How to display a session in its row. */
  labelOf: (s: S) => string;
  /** How to encode the session-tap callback. */
  sessionCallbackOf: (s: S) => string;
}

export interface RenderPickerPageOutput {
  rows: PickerButton[][];
  /** Clamped page actually rendered. */
  currentPage: number;
  /** Total pages given the session count. Minimum 1 (empty list = 1 page). */
  totalPages: number;
}

function trimLabel(s: string): string {
  return s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS - 1) + "…" : s;
}

export function renderPickerPage<S>(input: RenderPickerPageInput<S>): RenderPickerPageOutput {
  const { sessions, callbackPrefix, cancelCallback, labelOf, sessionCallbackOf } = input;
  const totalPages = Math.max(1, Math.ceil(sessions.length / MAX_SESSIONS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, input.page), totalPages);

  const start = (currentPage - 1) * MAX_SESSIONS_PER_PAGE;
  const slice = sessions.slice(start, start + MAX_SESSIONS_PER_PAGE);

  const rows: PickerButton[][] = [];
  for (const s of slice) {
    rows.push([{ label: trimLabel(labelOf(s)), callbackData: sessionCallbackOf(s) }]);
  }

  if (totalPages > 1) {
    const nav: PickerButton[] = [];
    if (currentPage > 1) {
      nav.push({ label: "⬅️ Prev", callbackData: `${callbackPrefix}_page_${currentPage - 1}` });
    }
    nav.push({
      label: `📄 ${currentPage}/${totalPages}`,
      callbackData: `${callbackPrefix}_page_noop`,
    });
    if (currentPage < totalPages) {
      nav.push({ label: "Next ➡️", callbackData: `${callbackPrefix}_page_${currentPage + 1}` });
    }
    rows.push(nav);
  }

  rows.push([{ label: "❌ Cancel", callbackData: cancelCallback }]);

  return { rows, currentPage, totalPages };
}
