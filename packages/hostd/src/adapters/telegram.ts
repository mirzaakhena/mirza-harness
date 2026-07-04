import {
  createPoller,
  type Context,
  type CreatePollerOptions,
  type Poller,
  type PollerStatus,
} from "@mirza-harness/telegram-adapter";
import type { HostdConfig } from "../config";

/**
 * Pemasangan N poller telegram-adapter di dalam hostd — satu poller per bot
 * di `config.bots` (Task C3, Fase 1). Fase 1 hanya memasang poller dan
 * melacak statusnya; belum menyambungkan `onInbound` ke pipeline nyata
 * (bus/delivery/gate — Task C4 dst belum ada). `deps.onInbound` disediakan
 * SEKARANG supaya wiring nanti tinggal mengisi callback ini, bukan
 * mengubah bentuk `startTelegramAdapters` lagi.
 */

export interface TelegramAdapterDeps {
  /** Dipanggil untuk setiap update masuk, per bot. Default: no-op (C4 belum ada). */
  onInbound?: (botId: string, ctx: Context) => void | Promise<void>;
  /**
   * Injeksi factory poller — dipakai test untuk mock grammy (tanpa network
   * nyata). Default: `createPoller` asli dari `@mirza-harness/telegram-adapter`.
   */
  createPoller?: (options: CreatePollerOptions) => Poller;
}

export interface TelegramAdaptersHandle {
  /** botId -> poller yang sedang berjalan. */
  pollers: ReadonlyMap<string, Poller>;
  /**
   * botId -> status poller TERBARU. Sumber untuk doctor komponen `adapters`
   * (map botId->state) — dibaca langsung, bukan snapshot beku, karena
   * `Map` yang sama diperbarui in-place setiap kali `onStatus` terpanggil.
   */
  statuses: ReadonlyMap<string, PollerStatus>;
  /** Hentikan semua poller (idempoten — masing-masing poller.stop() sendiri idempoten). */
  stopAll(): Promise<void>;
}

/**
 * Buat + start satu poller grammy per entri `config.bots`. Token sudah
 * di-trim & tervalidasi format oleh `loadConfig` (LOSS-5) sebelum sampai di
 * sini — modul ini tidak mengulang sanitasi token.
 */
export function startTelegramAdapters(
  config: HostdConfig,
  deps: TelegramAdapterDeps = {},
): TelegramAdaptersHandle {
  const onInbound = deps.onInbound ?? (() => {});
  const makePoller = deps.createPoller ?? createPoller;

  const pollers = new Map<string, Poller>();
  const statuses = new Map<string, PollerStatus>();

  for (const bot of config.bots) {
    statuses.set(bot.id, { state: "starting" });
    const poller = makePoller({
      token: bot.telegram_token,
      onInbound: (ctx) => onInbound(bot.id, ctx),
      onStatus: (status) => statuses.set(bot.id, status),
    });
    pollers.set(bot.id, poller);
    // Fire-and-forget: siklus hidup poller dilacak lewat `statuses`, bukan
    // lewat promise yang dikembalikan start() (itu hanya resolve saat poller
    // berhenti — dead/stopped/clean exit).
    void poller.start();
  }

  return {
    pollers,
    statuses,
    async stopAll(): Promise<void> {
      await Promise.all([...pollers.values()].map((poller) => poller.stop()));
    },
  };
}
