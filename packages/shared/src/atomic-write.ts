import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared atomic tmp+rename file writer with SCAR-022 (EPERM/EBUSY) retry.
 *
 * Kode acuan: `plugins/pty-controller/wrapper/src/wrapper.ts`'s
 * `persistRegistry` (mirza-marketplace, lines ~466-492) — Windows antivirus /
 * Search Indexer can briefly (<100ms) hold a destination file open, causing
 * `renameSync` to fail with EPERM/EBUSY even though the writer legitimately
 * holds whatever higher-level lock guards the write. Kode acuan retries with
 * a busy-wait (`while (Date.now() < until) {}`) — fine for a single-purpose
 * CLI wrapper, but wrong for a shared hostd util: a busy-wait blocks the
 * WHOLE event loop, stalling every other bot's I/O for the retry window.
 * This port uses non-blocking `setTimeout`-based sleeps instead — same
 * progressive backoff shape (50/100/150/200ms, 5 attempts total), same
 * retryable-error set, different (event-loop-friendly) wait mechanism. This
 * mirrors the same non-blocking choice already made in
 * `packages/hostd/src/shim/pending-consumer.ts`'s `withRetry`.
 *
 * First introduced for Task X1 (Fase 2, legacy-writer shim) but deliberately
 * placed here (not under `hostd/`) since any future writer needing the same
 * atomicity + retry guarantee (e.g. a Fase-1 leftover, or a future shim)
 * should reuse this rather than re-implementing the retry loop.
 */

/** Minimal fs surface this module needs, injectable for tests (e.g. to make
 * `rename` throw EPERM once then succeed) without reaching for module-level
 * mocking. Defaults to the real `node:fs`. */
export interface AtomicFsOps {
  mkdir: (dir: string) => void;
  writeFile: (path: string, data: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
}

export const defaultAtomicFsOps: AtomicFsOps = {
  mkdir: dir => mkdirSync(dir, { recursive: true }),
  writeFile: (path, data) => writeFileSync(path, data),
  rename: (from, to) => renameSync(from, to),
  unlink: path => unlinkSync(path),
  readFile: path => readFileSync(path, "utf8"),
  exists: path => existsSync(path),
};

/** Progressive backoff between rename retries — 5 attempts total (index
 * 0..4), same numbers as kode acuan's `persistRegistry` retry loop. */
export const SCAR_022_RETRY_BACKOFF_MS = [50, 100, 150, 200];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY";
}

export interface AtomicWriteOptions {
  /** fs seam for tests. Default: real node:fs. */
  fsOps?: Partial<AtomicFsOps>;
  /** Suffix appended after `.tmp.` in the temp filename. Default `<pid>.<random>` — random component avoids collisions between concurrent writers targeting the same final path from the same process. */
  tmpSuffix?: string;
}

/**
 * Write `data` to `path` atomically: write to a sibling `<path>.tmp.<suffix>`
 * file, then rename it onto `path`. The rename is retried on transient
 * Windows EPERM/EBUSY (SCAR-022) with progressive backoff; any other error,
 * or exhausting all retries, propagates to the caller. Creates `path`'s
 * parent directory (recursive) if missing.
 */
export async function atomicWriteFile(path: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const fs: AtomicFsOps = { ...defaultAtomicFsOps, ...opts.fsOps };
  fs.mkdir(dirname(path));
  const suffix = opts.tmpSuffix ?? `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${path}.tmp.${suffix}`;
  fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rename(tmp, path);
      return;
    } catch (err) {
      if (!isRetryableFsError(err) || attempt >= SCAR_022_RETRY_BACKOFF_MS.length) {
        // Best-effort cleanup: unlink tmp file before propagating the error.
        try {
          fs.unlink(tmp);
        } catch {
          // Ignore unlink errors; the original error is more important.
        }
        throw err;
      }
      await sleep(SCAR_022_RETRY_BACKOFF_MS[attempt]!);
    }
  }
}
