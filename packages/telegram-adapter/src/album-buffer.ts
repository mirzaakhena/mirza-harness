// Ported 1:1 from plugins/telegram/album-buffer.ts (mirza-marketplace).
// Only import/style conventions adapted (semicolons, double quotes); logic untouched.

export interface AlbumBufferOpts<T> {
  debounceMs: number;
  hardCapMs: number;
  maxItems: number;
  onFlush: (key: string, items: T[]) => Promise<void> | void;
}

export interface AlbumBuffer<T> {
  add: (key: string, item: T) => void;
  size: () => number;
  drainAll: () => Promise<void>;
}

interface Bucket<T> {
  items: T[];
  debounceTimer: ReturnType<typeof setTimeout>;
  hardTimer: ReturnType<typeof setTimeout>;
}

export function createAlbumBuffer<T>(opts: AlbumBufferOpts<T>): AlbumBuffer<T> {
  const buckets = new Map<string, Bucket<T>>();

  function flush(key: string): void {
    const bucket = buckets.get(key);
    if (!bucket) return;
    buckets.delete(key);
    clearTimeout(bucket.debounceTimer);
    clearTimeout(bucket.hardTimer);
    try {
      const ret = opts.onFlush(key, bucket.items);
      if (ret && typeof (ret as Promise<void>).then === "function") {
        (ret as Promise<void>).catch(err => {
          console.error(`[album-buffer] onFlush rejected for key=${key}:`, err);
        });
      }
    } catch (err) {
      console.error(`[album-buffer] onFlush threw for key=${key}:`, err);
    }
  }

  function add(key: string, item: T): void {
    const existing = buckets.get(key);
    if (existing) {
      existing.items.push(item);
      clearTimeout(existing.debounceTimer);
      existing.debounceTimer = setTimeout(() => flush(key), opts.debounceMs);
      if (existing.items.length >= opts.maxItems) {
        flush(key);
      }
      return;
    }
    const bucket: Bucket<T> = {
      items: [item],
      debounceTimer: setTimeout(() => flush(key), opts.debounceMs),
      hardTimer: setTimeout(() => flush(key), opts.hardCapMs),
    };
    buckets.set(key, bucket);
    if (bucket.items.length >= opts.maxItems) {
      flush(key);
    }
  }

  function size(): number {
    return buckets.size;
  }

  async function drainAll(): Promise<void> {
    const pendingKeys = [...buckets.keys()];
    const pendingPromises: Array<Promise<unknown>> = [];
    for (const key of pendingKeys) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      buckets.delete(key);
      clearTimeout(bucket.debounceTimer);
      clearTimeout(bucket.hardTimer);
      try {
        const ret = opts.onFlush(key, bucket.items);
        if (ret && typeof (ret as Promise<void>).then === "function") {
          pendingPromises.push((ret as Promise<unknown>).catch(err => {
            console.error(`[album-buffer] drainAll onFlush rejected key=${key}:`, err);
          }));
        }
      } catch (err) {
        console.error(`[album-buffer] drainAll onFlush threw key=${key}:`, err);
      }
    }
    await Promise.all(pendingPromises);
  }

  return { add, size, drainAll };
}
