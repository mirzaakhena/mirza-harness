import { Bot, GrammyError, type Context } from "grammy";

// Re-exported so consumers (mis. packages/hostd) can type onInbound callbacks
// without adding their own direct dependency on grammy.
export type { Context };

/**
 * Poller lifecycle — port dari `plugins/telegram/server.ts:99-206,2141-2195`
 * (mirza-marketplace, kode acuan Task C3). Retry/backoff long-poll mengikuti
 * kode acuan persis (delay = min(1000*attempt, 15000), reset attempt saat
 * `onStart` sukses), dengan dua fix yang kode acuan TIDAK punya:
 *
 * - LOSS-6: kode acuan berhenti retry setelah 8x 409 Conflict beruntun, tapi
 *   PROSES TETAP HIDUP (MCP stdin masih terbuka) — jadi "mati" hanya dari
 *   sisi polling, bukan proses. Itu zombie: doctor/operator tidak tahu bot
 *   sudah berhenti mendengarkan. Di hostd, supervisor adalah satu-satunya
 *   sumber kebenaran hidup/mati poller — begitu ambang 409 tercapai, poller
 *   ini eksplisit memanggil stop() atas dirinya sendiri DAN melapor
 *   `{state:'dead', reason:'conflict-409'}` lewat onStatus, supaya doctor
 *   hostd (komponen `adapters`) melihat merah dan operator tahu perlu
 *   campur tangan — bukan diam-diam menganggur selamanya.
 * - SCAR-061: kode acuan tidak memasang `bot.catch` eksplisit. Error yang
 *   dilempar middleware/handler grammy di tengah pemrosesan satu update
 *   (BUKAN error long-poll) jatuh ke default error handler grammy (log lalu
 *   rethrow) — berpotensi jadi unhandledRejection yang mematikan proses.
 *   Di sini `bot.catch` dipasang eksplisit: log + lapor
 *   `{state:'degraded', reason}` TANPA memanggil stop() — satu update yang
 *   gagal diproses tidak boleh menjatuhkan seluruh poller; long-poll lain
 *   tetap jalan.
 *
 * SCAR-050 (SENGAJA TIDAK DIPORT): kode acuan punya takeover pid-file (baca
 * `bot.pid`, kill proses lama yang masih pegang token) karena tiap sesi
 * Claude Code menjalankan proses server.ts sendiri-sendiri tanpa supervisor
 * bersama — jadi butuh mekanisme "singkirkan pemegang lama" sendiri. Di
 * mirza-harness, hostd adalah SATU proses supervisor untuk semua poller;
 * "satu poller per token" dijamin oleh model proses-tunggal hostd itu
 * sendiri (tidak ada instance hostd kedua yang diam-diam start poller untuk
 * token yang sama). Takeover pid-file DIGANTI oleh supervisi proses-tunggal
 * hostd — jangan port logic pid-file ke modul ini.
 */

/** Status lifecycle poller, dilaporkan lewat `onStatus`. */
export type PollerStatus =
  | { state: "starting" }
  | { state: "running"; username?: string }
  | { state: "degraded"; reason: string }
  | { state: "dead"; reason: string }
  | { state: "stopped" };

/**
 * Subset API grammy `Bot` yang benar-benar dipakai poller ini. Dideklarasi
 * eksplisit (bukan `import type { Bot }` langsung) supaya test bisa
 * menyuntik mock murni lewat `botFactory` tanpa jaringan nyata.
 */
export interface PollerBot {
  use(middleware: (ctx: Context, next: () => Promise<void>) => unknown): unknown;
  start(options?: { onStart?: (info: { username: string }) => void }): Promise<void>;
  stop(): Promise<void>;
  /** grammy: properti yang di-assign handler, bukan method yang dipanggil bot. */
  catch: ((err: unknown) => void) | undefined;
}

export type BotFactory = (token: string) => PollerBot;

export interface CreatePollerOptions {
  token: string;
  /** Dipanggil untuk setiap update masuk. C4 (pipeline) belum ada — caller (hostd adapter) boleh pasang no-op. */
  onInbound?: (ctx: Context) => void | Promise<void>;
  onStatus?: (status: PollerStatus) => void;
  /** Injeksi factory grammy `Bot` — dipakai test untuk mock (tanpa network). Default: `new Bot(token)`. */
  botFactory?: BotFactory;
  /** Ambang 409 Conflict beruntun sebelum poller dianggap dead (LOSS-6). Default 8 — ikut kode acuan. */
  conflictThreshold?: number;
  /**
   * Fungsi delay retry (ms) per attempt. Default ikut kode acuan:
   * `min(1000*attempt, 15000)`. Parameter ini HANYA untuk mempercepat test
   * (backoff produksi dibiarkan default) — bukan bagian dari spec kode acuan.
   */
  retryDelayMs?: (attempt: number) => number;
}

export interface Poller {
  /**
   * Mulai long-poll (idempotent — panggilan kedua sebelum stop() adalah
   * no-op, mengembalikan promise yang sama). Promise yang dikembalikan
   * resolve saat loop poll berhenti (dead, stopped, atau clean exit) — jadi
   * bersifat fire-and-forget bagi caller yang tidak butuh menunggunya, tapi
   * bisa di-`await` (mis. di test) untuk tahu kapan siklus hidup berakhir.
   */
  start(): Promise<void>;
  /** Hentikan long-poll (idempotent — aman dipanggil berkali-kali / sebelum start()). */
  stop(): Promise<void>;
}

const CONFLICT_THRESHOLD_DEFAULT = 8;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1000 * attempt, 15000);
}

/** 409 Conflict: instanceof GrammyError di jalur produksi, duck-typed di jalur test (mock). */
function isConflict409(err: unknown): boolean {
  if (err instanceof GrammyError) return err.error_code === 409;
  return (
    typeof err === "object" &&
    err !== null &&
    "error_code" in err &&
    (err as { error_code?: unknown }).error_code === 409
  );
}

export function createPoller(options: CreatePollerOptions): Poller {
  const {
    token,
    onInbound,
    onStatus,
    conflictThreshold = CONFLICT_THRESHOLD_DEFAULT,
    retryDelayMs = defaultRetryDelayMs,
  } = options;
  const botFactory: BotFactory = options.botFactory ?? ((t) => new Bot(t) as unknown as PollerBot);
  const bot = botFactory(token);

  let started = false;
  let stopping = false;
  let dead = false;
  let loopPromise: Promise<void> | null = null;

  const emit = (status: PollerStatus): void => {
    try {
      onStatus?.(status);
    } catch {
      /* listener status tidak boleh menjatuhkan poller */
    }
  };

  if (onInbound) {
    bot.use(async (ctx, next) => {
      await onInbound(ctx);
      await next();
    });
  }

  // SCAR-061: pasang bot.catch eksplisit — error di tengah pemrosesan satu
  // update dilog + dilaporkan degraded, TIDAK memanggil stop(). Long-poll
  // tetap jalan; ini bukan kegagalan getUpdates.
  bot.catch = (err: unknown): void => {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `telegram poller: error saat proses update (degraded, polling tetap jalan): ${reason}\n`,
    );
    emit({ state: "degraded", reason });
  };

  async function stopInternal(): Promise<void> {
    if (stopping) return;
    stopping = true;
    try {
      await bot.stop();
    } catch {
      /* bot.stop() sebelum start / sudah stop — abaikan, stop() tetap idempoten */
    }
    if (!dead) emit({ state: "stopped" });
  }

  async function runLoop(): Promise<void> {
    let conflictStreak = 0;
    for (let attempt = 1; ; attempt++) {
      if (stopping) return;
      try {
        await bot.start({
          onStart: (info) => {
            attempt = 0;
            conflictStreak = 0;
            emit({ state: "running", username: info.username });
          },
        });
        return; // bot.stop() dipanggil — keluar bersih, bukan error
      } catch (err) {
        if (stopping) return;
        // grammy: bot.stop() mid-connect menolak dgn "Aborted delay" — diharapkan, bukan error.
        if (err instanceof Error && err.message === "Aborted delay") return;

        const conflict = isConflict409(err);
        if (conflict) {
          conflictStreak++;
          if (conflictStreak >= conflictThreshold) {
            dead = true;
            process.stderr.write(
              `telegram poller: 409 Conflict bertahan setelah ${conflictStreak}x — poller lain masih pegang token ini. Berhenti (dead), BUKAN zombie.\n`,
            );
            emit({ state: "dead", reason: "conflict-409" });
            await stopInternal();
            return;
          }
        } else {
          conflictStreak = 0;
        }

        const delay = retryDelayMs(attempt);
        const detail = conflict
          ? `409 Conflict${conflictStreak === 1 ? " — instance lain sedang polling token ini" : ""} (${conflictStreak}/${conflictThreshold})`
          : `polling error: ${err}`;
        process.stderr.write(`telegram poller: ${detail}, retry dlm ${delay / 1000}s\n`);
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  return {
    start(): Promise<void> {
      if (started) return loopPromise ?? Promise.resolve();
      started = true;
      emit({ state: "starting" });
      loopPromise = runLoop();
      return loopPromise;
    },
    async stop(): Promise<void> {
      await stopInternal();
      if (loopPromise) await loopPromise.catch(() => {});
    },
  };
}
