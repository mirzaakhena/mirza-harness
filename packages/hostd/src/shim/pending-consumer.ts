import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { Envelope, MAX_HOP, parseLegacyPending, type EnvelopeT } from "@mirza-harness/shared";

/**
 * Shim consumer for the legacy pending/*.json mailbox (Task X2, Fase 2).
 *
 * Kode acuan: `plugins/pty-controller/wrapper/src/wrapper.ts:987-1240`
 * (`consumePending`/`dispatchPayload` + the fs.watch/sweep pair at the
 * bottom of the file) — mirza-marketplace. Payload shapes come from
 * `plugins/pty-controller/ipc.ts` (`writeCommand`/`writeBatch`) and
 * `plugins/agent-bus/prompt-compose.ts` (`writePromptToPending`).
 *
 * Direction reversal vs. kode acuan: the OLD wrapper.ts *wrote* pending
 * files (from inside CC, via the pty-controller MCP tool) and consumed them
 * itself to drive its own PTY. HERE, during the mixed-fleet window of Fase
 * 2, this hostd-side consumer reads pending files written by an OLD
 * bot-lama's agent-bus (`writePromptToPending`) or pty-controller
 * (`writeCommand`/`writeBatch`) that target THIS (new-harness) pilot bot —
 * see recon-wrapper.md §F ("hostd KONSUMSI selama fase 2") and
 * recon-hooks.md §D.
 *
 * Validation is centralized in `@mirza-harness/shared`'s
 * `parseLegacyPending` (recon-hooks §D, "ambiguitas #2 — titik validasi
 * tunggal") — this module owns filesystem mechanics + dispatch only.
 *
 * SCAR-021 (fs.watch/sweep): fs.watch covers the happy path with a 50ms
 * defer so a writer's tmp+rename has time to commit on Windows; a 2s sweep
 * interval is the belt-and-suspenders fallback for missed/duplicate
 * fs.watch events (also the primary driver in tests, which shrink the
 * interval).
 *
 * SCAR-022 (retry EPERM/EBUSY): Windows antivirus/Search Indexer can hold a
 * file handle open for a <100ms window, causing read/rename/unlink to fail
 * transiently. Retried with progressive backoff 50/100/150/200ms (5
 * attempts total) — exact shape of `persistRegistry`'s retry loop in kode
 * acuan (`wrapper.ts:466-492`), ported to non-blocking async sleeps instead
 * of a busy-wait (this consumer is async end-to-end; a busy-wait would
 * block the whole hostd event loop).
 *
 * LOSS-3 (idempotency by id): processed payload ids are tracked in-memory
 * for the lifetime of this consumer; a file whose payload id was already
 * handled is deleted without re-enqueuing. `enqueueEnv` may also return
 * `false` (bus-level duplicate, e.g. after a hostd restart re-processes a
 * file that never got deleted) — treated the same way: not an error, just
 * skip+delete. Note: `id` is mandatory for prompt/command payloads (per
 * schema); the fallback to `fileStem` applies only to batch payloads, which
 * have no id field and rely on the filename UUID as the stable identity.
 */

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Sink for a `command`/`batch` payload. S1 (bot-supervisor injection queue)
 * does not exist yet — this is "cukup kontrak callback" per the task brief;
 * whatever owns the real injection queue plugs in here later. */
export interface InjectRequest {
  id: string;
  commands: string[];
}

export type PendingStatus =
  | { level: "info"; message: string; file?: string }
  | { level: "warning"; message: string; file: string };

/** Minimal fs surface this module needs, injectable for tests (e.g. to make
 * `rename` throw EPERM once then succeed — SCAR-022 retry coverage) without
 * reaching for module-level mocking. Defaults to the real `node:fs`. */
export interface PendingFsOps {
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  readdir: (path: string) => string[];
  readFile: (path: string) => string;
  remove: (path: string) => void;
  rename: (from: string, to: string) => void;
  watch: (path: string, listener: (eventType: string, filename: string | null) => void) => { close: () => void };
}

const defaultFsOps: PendingFsOps = {
  exists: p => existsSync(p),
  mkdir: p => mkdirSync(p, { recursive: true }),
  readdir: p => readdirSync(p),
  readFile: p => readFileSync(p, "utf8"),
  remove: p => rmSync(p),
  rename: (from, to) => renameSync(from, to),
  watch: (p, listener) => watch(p, (eventType, filename) => listener(eventType, filename?.toString() ?? null)),
};

export interface StartPendingConsumerOptions {
  /** Directory to watch (the bot-lama's pty-controller pending/ dir, seen from this pilot). */
  dir: string;
  /** Pilot bot id — becomes `Envelope.to` for prompt payloads. */
  botId: string;
  /** Bus sink. Returning `false` signals a bus-level duplicate (already enqueued) — treated as a no-op, not an error. */
  enqueueEnv: (env: EnvelopeT) => boolean | void;
  /** Injection-queue sink for command/batch payloads (S1 not built yet — plain callback contract). */
  enqueueInject: (req: InjectRequest) => void;
  /** Observe warnings (quarantined files) and informational events. Default: no-op. */
  onStatus?: (status: PendingStatus) => void;
  /** Injectable clock (ms), default `Date.now`. */
  now?: () => number;
  /** Defer before handling an fs.watch event, ms. Default 50 (SCAR-021). */
  deferMs?: number;
  /** Sweep-fallback interval, ms. Default 2000 (SCAR-021). */
  sweepIntervalMs?: number;
  /** fs seam for tests. Default: real node:fs. */
  fsOps?: Partial<PendingFsOps>;
}

export interface PendingConsumerHandle {
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Retry (SCAR-022)
// ---------------------------------------------------------------------------

/** Progressive backoff between retries — 5 attempts total (index 0..4), same
 * numbers as kode acuan's `persistRegistry` retry loop. */
const RETRY_BACKOFF_MS = [50, 100, 150, 200];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EBUSY";
}

async function withRetry<T>(op: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return op();
    } catch (err) {
      if (!isRetryableFsError(err) || attempt >= RETRY_BACKOFF_MS.length) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt]!);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function startPendingConsumer(options: StartPendingConsumerOptions): PendingConsumerHandle {
  const fs: PendingFsOps = { ...defaultFsOps, ...options.fsOps };
  const onStatus = options.onStatus ?? (() => {});
  const now = options.now ?? Date.now;
  const deferMs = options.deferMs ?? 50;
  const sweepIntervalMs = options.sweepIntervalMs ?? 2_000;

  try {
    fs.mkdir(options.dir);
  } catch {
    /* best-effort — a missing dir surfaces again on the first watch/sweep failure */
  }

  // LOSS-3: payload ids already handled, kept for the process lifetime.
  const processed = new Set<string>();
  // Guards against the same filename being processed twice concurrently
  // (fs.watch firing while a sweep tick is mid-flight on the same file).
  const inFlight = new Set<string>();
  // SCAR-022: track pending timers to cancel on stop() (prevent enqueue after stop).
  const deferTimers = new Set<ReturnType<typeof setTimeout>>();
  // Flag to prevent processing after stop() is called.
  let stopped = false;

  async function quarantine(filePath: string, filename: string, reason: string): Promise<void> {
    const rejectedPath = `${filePath}.rejected-${Date.now()}`;
    try {
      await withRetry(() => fs.rename(filePath, rejectedPath));
    } catch (err) {
      onStatus({ level: "warning", message: `failed to quarantine ${filename}: ${err}`, file: filePath });
      return;
    }
    onStatus({ level: "warning", message: `quarantined ${filename}: ${reason}`, file: filePath });
  }

  async function removeFile(filePath: string): Promise<void> {
    try {
      await withRetry(() => fs.remove(filePath));
    } catch {
      /* already gone (or truly stuck) is fine — matches kode acuan's eager-delete swallow */
    }
  }

  async function processFile(filename: string): Promise<void> {
    if (stopped) return; // SCAR-022: guard against processing after stop()
    if (!filename.endsWith(".json")) return;
    if (filename.includes(".tmp.")) return; // mid-write marker (writeCommand/writeBatch/writePromptToPending)
    if (inFlight.has(filename)) return;

    const filePath = join(options.dir, filename);
    if (!fs.exists(filePath)) return; // already handled by a concurrent pass

    inFlight.add(filename);
    try {
      let raw: string;
      try {
        raw = await withRetry(() => fs.readFile(filePath));
      } catch (err) {
        onStatus({ level: "warning", message: `failed to read ${filename}: ${err}`, file: filePath });
        return; // leave file for the next sweep — transient, already retried
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        await quarantine(filePath, filename, `invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const result = parseLegacyPending(json);
      if (!result.ok) {
        await quarantine(filePath, filename, result.error);
        return;
      }

      const fileStem = basename(filename, ".json");

      if (result.kind === "prompt") {
        const id = result.payload.id || fileStem;
        if (processed.has(id)) {
          await removeFile(filePath);
          return;
        }
        if (result.payload.hop_count > MAX_HOP) {
          // Parity with kode acuan's hop-limit drop (wrapper.ts:1045-1048):
          // silently drop, not a schema failure — no quarantine.
          processed.add(id);
          onStatus({
            level: "info",
            message: `dropping ${filename}: hop_count ${result.payload.hop_count} exceeds ${MAX_HOP}`,
            file: filePath,
          });
          await removeFile(filePath);
          return;
        }
        let env: EnvelopeT;
        try {
          env = Envelope.parse({
            id,
            ts: Math.floor(now() / 1000),
            from: result.payload.from,
            to: options.botId,
            kind: "prompt",
            // `text` arrives already composed by the sending bot-lama's
            // agent-bus (anti-bounce marker + flattened body) — passed through
            // as `content` verbatim, never re-composed here.
            payload: {
              content: result.payload.text,
              meta: { from: result.payload.from, hop: String(result.payload.hop_count), kind: "legacy-pending-prompt" },
            },
            hop: result.payload.hop_count,
          });
        } catch (err) {
          await quarantine(filePath, filename, `envelope schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        const queued = options.enqueueEnv(env);
        processed.add(id);
        if (queued === false) {
          onStatus({ level: "info", message: `duplicate id ${id} already on bus — skipped`, file: filePath });
        }
        await removeFile(filePath);
        return;
      }

      if (result.kind === "command") {
        const id = result.payload.id || fileStem;
        if (processed.has(id)) {
          await removeFile(filePath);
          return;
        }
        // Parity with kode acuan's hop-limit drop (wrapper.ts:1045-1048):
        // drop command payloads with from + hop_count > MAX_HOP, same as prompt.
        if (result.payload.from && result.payload.hop_count && result.payload.hop_count > MAX_HOP) {
          processed.add(id);
          onStatus({
            level: "info",
            message: `dropping ${filename}: hop_count ${result.payload.hop_count} exceeds ${MAX_HOP}`,
            file: filePath,
          });
          await removeFile(filePath);
          return;
        }
        options.enqueueInject({ id, commands: [result.payload.command] });
        processed.add(id);
        await removeFile(filePath);
        return;
      }

      // batch — writeBatch never assigns an id to the array root or its
      // items, so the file's own name (a UUID minted by the writer) is the
      // stable identity for the batch as a whole.
      const id = fileStem;
      if (processed.has(id)) {
        await removeFile(filePath);
        return;
      }
      options.enqueueInject({ id, commands: result.items.map(item => item.command) });
      processed.add(id);
      await removeFile(filePath);
    } finally {
      inFlight.delete(filename);
    }
  }

  const watcher = fs.watch(options.dir, (_eventType, filename) => {
    if (!filename) return;
    const timer = setTimeout(() => {
      deferTimers.delete(timer);
      if (!fs.exists(join(options.dir, filename))) return;
      void processFile(filename);
    }, deferMs);
    deferTimers.add(timer);
  });

  const sweepInterval = setInterval(() => {
    let names: string[];
    try {
      names = fs.readdir(options.dir);
    } catch {
      return; // dir missing transiently — next tick retries
    }
    for (const f of names) void processFile(f);
  }, sweepIntervalMs);

  return {
    stop() {
      stopped = true;
      // SCAR-022: cancel all pending deferred processFile calls
      for (const timer of deferTimers) clearTimeout(timer);
      deferTimers.clear();
      watcher.close();
      clearInterval(sweepInterval);
    },
  };
}
