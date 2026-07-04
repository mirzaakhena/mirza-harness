// Ported 1:1 from plugins/telegram/album-buffer.test.ts (mirza-marketplace).
// Only import path and style conventions adapted (semicolons, double quotes).

import { test, expect, describe } from "bun:test";
import { createAlbumBuffer } from "../src/album-buffer";

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe("album-buffer: debounce flush", () => {
  test("single item flushes after debounce window", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 40,
      hardCapMs: 1000,
      maxItems: 10,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    buf.add("A", 1);
    expect(flushed).toEqual([]);
    await wait(80);
    expect(flushed).toEqual([{ key: "A", items: [1] }]);
    expect(buf.size()).toBe(0);
  });
});

describe("album-buffer: debounce reset", () => {
  test("3 items in window flush as single batch after last item + debounce", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 40,
      hardCapMs: 1000,
      maxItems: 10,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    buf.add("A", 1);
    await wait(20);
    buf.add("A", 2);
    await wait(20);
    buf.add("A", 3);
    expect(flushed).toEqual([]); // total elapsed ~40ms, debounce reset means we should not have flushed yet
    await wait(80);
    expect(flushed).toEqual([{ key: "A", items: [1, 2, 3] }]);
  });
});

describe("album-buffer: hard cap", () => {
  test("continuous stream flushes at hardCapMs even though debounce keeps resetting", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 80,
      hardCapMs: 200,
      maxItems: 100,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    // Stream items every 40ms — debounce (80ms) keeps resetting,
    // but hard cap (200ms) should fire and flush.
    // All 5 items land at t≈0,40,80,120,160 — all before the 200ms hard cap.
    const t0 = Date.now();
    buf.add("A", 1);
    await wait(40); buf.add("A", 2);
    await wait(40); buf.add("A", 3);
    await wait(40); buf.add("A", 4);
    await wait(40); buf.add("A", 5);
    // Total elapsed ~160ms — wait another 100ms for hard cap (200ms) to fire.
    await wait(100);
    const elapsed = Date.now() - t0;

    expect(flushed.length).toBe(1);
    expect(flushed[0].key).toBe("A");
    expect(flushed[0].items.length).toBe(5);
    expect(elapsed).toBeLessThan(400); // sanity: didn't wait debounce
    expect(buf.size()).toBe(0);
  });
});

describe("album-buffer: max items", () => {
  test("reaching maxItems flushes immediately without waiting debounce", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 1000, // intentionally long
      hardCapMs: 5000, // intentionally long
      maxItems: 3,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    const t0 = Date.now();
    buf.add("A", 1);
    buf.add("A", 2);
    buf.add("A", 3);
    // Should flush before any timer fires.
    await wait(20);
    const elapsed = Date.now() - t0;

    expect(flushed).toEqual([{ key: "A", items: [1, 2, 3] }]);
    expect(elapsed).toBeLessThan(100); // way under debounceMs
  });

  test("item N+1 after max-flush starts a fresh bucket", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 40,
      hardCapMs: 200,
      maxItems: 2,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    buf.add("A", 1);
    buf.add("A", 2); // triggers max-flush
    await wait(10);
    buf.add("A", 3); // fresh bucket
    await wait(80);

    expect(flushed).toEqual([
      { key: "A", items: [1, 2] },
      { key: "A", items: [3] },
    ]);
  });
});

describe("album-buffer: multi-key isolation", () => {
  test("interleaved keys flush separately with correct items", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 40,
      hardCapMs: 1000,
      maxItems: 100,
      onFlush: (key, items) => { flushed.push({ key, items }); },
    });

    buf.add("A", 1);
    buf.add("B", 10);
    buf.add("A", 2);
    buf.add("B", 20);
    buf.add("A", 3);
    await wait(80);

    expect(flushed).toHaveLength(2);
    const a = flushed.find(f => f.key === "A")!;
    const b = flushed.find(f => f.key === "B")!;
    expect(a.items).toEqual([1, 2, 3]);
    expect(b.items).toEqual([10, 20]);
  });
});

describe("album-buffer: drainAll", () => {
  test("drainAll flushes all pending buckets and resolves", async () => {
    const flushed: Array<{ key: string; items: number[] }> = [];
    const buf = createAlbumBuffer<number>({
      debounceMs: 1000, // long enough that nothing flushes naturally
      hardCapMs: 5000,
      maxItems: 100,
      onFlush: async (key, items) => {
        await wait(10);
        flushed.push({ key, items });
      },
    });

    buf.add("A", 1);
    buf.add("B", 2);
    buf.add("A", 3);
    expect(buf.size()).toBe(2);

    await buf.drainAll();

    expect(buf.size()).toBe(0);
    expect(flushed).toHaveLength(2);
    expect(flushed.find(f => f.key === "A")!.items).toEqual([1, 3]);
    expect(flushed.find(f => f.key === "B")!.items).toEqual([2]);
  });

  test("drainAll on empty buffer is no-op", async () => {
    const buf = createAlbumBuffer<number>({
      debounceMs: 40,
      hardCapMs: 1000,
      maxItems: 10,
      onFlush: () => {},
    });
    await expect(buf.drainAll()).resolves.toBeUndefined();
  });
});

describe("album-buffer: error isolation", () => {
  test("onFlush throw does not corrupt buffer state", async () => {
    const errors: unknown[] = [];
    const onError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };

    try {
      const buf = createAlbumBuffer<number>({
        debounceMs: 40,
        hardCapMs: 1000,
        maxItems: 10,
        onFlush: () => { throw new Error("boom"); },
      });

      buf.add("A", 1);
      await wait(80);

      expect(buf.size()).toBe(0);
      expect(errors.length).toBeGreaterThan(0);

      // Buffer still functional after error.
      let secondCalled = false;
      const buf2 = createAlbumBuffer<number>({
        debounceMs: 40,
        hardCapMs: 1000,
        maxItems: 10,
        onFlush: () => { secondCalled = true; },
      });
      buf2.add("B", 2);
      await wait(80);
      expect(secondCalled).toBe(true);
    } finally {
      console.error = onError;
    }
  });

  test("onFlush rejection (async throw) does not crash", async () => {
    const errors: unknown[] = [];
    const onError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };

    try {
      const buf = createAlbumBuffer<number>({
        debounceMs: 40,
        hardCapMs: 1000,
        maxItems: 10,
        onFlush: async () => { throw new Error("async boom"); },
      });

      buf.add("A", 1);
      await wait(80);
      // Give the rejected promise a tick to surface.
      await wait(20);

      expect(buf.size()).toBe(0);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = onError;
    }
  });
});
