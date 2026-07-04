// Ported 1:1 from plugins/telegram/paginated-picker.test.ts (mirza-marketplace).
// Only import path and style conventions adapted (semicolons, double quotes).

import { describe, test, expect } from "bun:test";
import { renderPickerPage, MAX_SESSIONS_PER_PAGE } from "../src/paginated-picker";

interface FakeSession {
  shortId: string;
  label: string;
}

const fakes = (n: number): FakeSession[] =>
  Array.from({ length: n }, (_, i) => ({
    shortId: `id${String(i).padStart(2, "0")}`,
    label: `session ${i}`,
  }));

const labelOf = (s: FakeSession) => s.label;
const cbOf = (s: FakeSession) => `meta:switch_${s.shortId}`;

describe("renderPickerPage", () => {
  test("MAX_SESSIONS_PER_PAGE is 6", () => {
    expect(MAX_SESSIONS_PER_PAGE).toBe(6);
  });

  test("single page (<=6 sessions): no nav row, just sessions + cancel", () => {
    const sessions = fakes(3);
    const { rows, currentPage, totalPages } = renderPickerPage({
      sessions,
      page: 1,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(currentPage).toBe(1);
    expect(totalPages).toBe(1);
    expect(rows.length).toBe(4); // 3 sessions + cancel, no nav
    expect(rows[0]).toEqual([{ label: "session 0", callbackData: "meta:switch_id00" }]);
    expect(rows[3]).toEqual([{ label: "❌ Cancel", callbackData: "meta:switch_cancel" }]);
  });

  test("exactly MAX (6) sessions: no nav row", () => {
    const sessions = fakes(6);
    const { rows, totalPages } = renderPickerPage({
      sessions,
      page: 1,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(totalPages).toBe(1);
    expect(rows.length).toBe(7); // 6 sessions + cancel
  });

  test("two pages: nav row with indicator + Next only on page 1", () => {
    const sessions = fakes(9); // 6 + 3
    const { rows, currentPage, totalPages } = renderPickerPage({
      sessions,
      page: 1,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(currentPage).toBe(1);
    expect(totalPages).toBe(2);
    expect(rows.length).toBe(8); // 6 sessions + nav + cancel
    expect(rows[6]).toEqual([
      { label: "📄 1/2", callbackData: "meta:switch_page_noop" },
      { label: "Next ➡️", callbackData: "meta:switch_page_2" },
    ]);
    expect(rows[7]).toEqual([{ label: "❌ Cancel", callbackData: "meta:switch_cancel" }]);
  });

  test("two pages: nav row with Prev + indicator on last page", () => {
    const sessions = fakes(9);
    const { rows, currentPage } = renderPickerPage({
      sessions,
      page: 2,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(currentPage).toBe(2);
    expect(rows.length).toBe(5); // 3 sessions on page 2 + nav + cancel
    expect(rows[0]).toEqual([{ label: "session 6", callbackData: "meta:switch_id06" }]);
    expect(rows[3]).toEqual([
      { label: "⬅️ Prev", callbackData: "meta:switch_page_1" },
      { label: "📄 2/2", callbackData: "meta:switch_page_noop" },
    ]);
  });

  test("three pages: middle page has Prev, indicator, Next", () => {
    const sessions = fakes(15); // 3 pages of 6/6/3
    const { rows, currentPage, totalPages } = renderPickerPage({
      sessions,
      page: 2,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(currentPage).toBe(2);
    expect(totalPages).toBe(3);
    expect(rows.length).toBe(8);
    expect(rows[6]).toEqual([
      { label: "⬅️ Prev", callbackData: "meta:switch_page_1" },
      { label: "📄 2/3", callbackData: "meta:switch_page_noop" },
      { label: "Next ➡️", callbackData: "meta:switch_page_3" },
    ]);
  });

  test("out-of-range page clamps to last page", () => {
    const sessions = fakes(9);
    const { currentPage, totalPages } = renderPickerPage({
      sessions,
      page: 99,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(totalPages).toBe(2);
    expect(currentPage).toBe(2);
  });

  test("page < 1 clamps to 1", () => {
    const sessions = fakes(9);
    const { currentPage } = renderPickerPage({
      sessions,
      page: 0,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(currentPage).toBe(1);
  });

  test("label longer than 60 chars is truncated with ellipsis", () => {
    const sessions: FakeSession[] = [{ shortId: "abcdef00", label: "a".repeat(80) }];
    const { rows } = renderPickerPage({
      sessions,
      page: 1,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(rows[0]![0]!.label.length).toBeLessThanOrEqual(60);
    expect(rows[0]![0]!.label.endsWith("…")).toBe(true);
  });

  test("zero sessions yields just the cancel row", () => {
    const { rows, totalPages } = renderPickerPage<FakeSession>({
      sessions: [],
      page: 1,
      callbackPrefix: "meta:switch",
      cancelCallback: "meta:switch_cancel",
      labelOf,
      sessionCallbackOf: cbOf,
    });
    expect(totalPages).toBe(1);
    expect(rows).toEqual([[{ label: "❌ Cancel", callbackData: "meta:switch_cancel" }]]);
  });

  test("callback prefix is preserved verbatim (works for delete, archive too)", () => {
    const sessions = fakes(8);
    const { rows } = renderPickerPage({
      sessions,
      page: 1,
      callbackPrefix: "meta:archive",
      cancelCallback: "meta:archive_cancel",
      labelOf,
      sessionCallbackOf: s => `meta:archive_${s.shortId}`,
    });
    expect(rows[0]).toEqual([{ label: "session 0", callbackData: "meta:archive_id00" }]);
    expect(rows[6]).toEqual([
      { label: "📄 1/2", callbackData: "meta:archive_page_noop" },
      { label: "Next ➡️", callbackData: "meta:archive_page_2" },
    ]);
  });
});
