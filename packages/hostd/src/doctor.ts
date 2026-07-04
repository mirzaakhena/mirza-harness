import type { Database } from "bun:sqlite";
import { busStats } from "./bus/bus";
import type { DeliveryStats } from "./bus/delivery";

export const HOSTD_VERSION = "0.0.1";

export interface DoctorReport {
  ok: boolean;
  version: string;
  pid: number;
  uptime_s: number;
  db: string;
  components: Record<string, string>;
}

/** Structural subset of telegram-adapter's `PollerStatus` actually needed here — avoids a hard type import for a single field. */
export interface DoctorPollerStatusLike {
  state: string;
}

export interface DoctorDeps {
  /** Bila ada, komponen `bus` dilaporkan dari busStats(db) alih-alih "stub". */
  db?: Database;
  /**
   * Task D2, Fase 1 — bila ada, komponen `adapters` dilaporkan sbg
   * `{botId: pollerState}` (dari `startTelegramAdapters(...).statuses`)
   * alih-alih "stub".
   */
  adapterStatuses?: ReadonlyMap<string, DoctorPollerStatusLike>;
  /**
   * Task D2, Fase 1 — bila ada (BERSAMA `db`), digabung ke dalam komponen
   * `bus` sbg field `delivery` (dari `startDelivery`'s tick stats). Tidak
   * berpengaruh tanpa `db` (komponen bus tetap "stub").
   */
  deliveryStats?: DeliveryStats;
}

/**
 * Laporan doctor. `deps` opsional — tanpa argumen, perilaku identik dgn
 * fase 0 (semua komponen "stub"), demi kompatibilitas mundur.
 *
 * Catatan (deferred dari review B1, SCAR): `Envelope.ts` disuplai oleh
 * caller tanpa clamp/validasi rentang waktu — enqueue tidak menolak `ts` di
 * masa depan. Akibatnya `busStats().oldest_unacked_s` (dihitung sbg
 * `now - min(ts)`) bisa negatif. Perbaikan sumber (menolak/menjepit `ts` saat
 * enqueue) didokumentasikan sbg follow-up terpisah di luar scope task ini
 * (tidak menyentuh bus/bus.ts). Di sini, saat wiring stats ke doctor, kita
 * jepit (clamp) NILAI TAMPILAN oldest_unacked_s ke >= 0 supaya laporan
 * doctor tidak menampilkan angka negatif yang membingungkan.
 */
export function doctorReport(deps: DoctorDeps = {}): DoctorReport {
  let busComponent = "stub";
  if (deps.db) {
    const stats = busStats(deps.db);
    const clamped = { ...stats, oldest_unacked_s: Math.max(0, stats.oldest_unacked_s) };
    const merged = deps.deliveryStats ? { ...clamped, delivery: deps.deliveryStats } : clamped;
    busComponent = JSON.stringify(merged);
  }

  let adaptersComponent = "stub";
  if (deps.adapterStatuses) {
    const byBot: Record<string, string> = {};
    for (const [botId, status] of deps.adapterStatuses) byBot[botId] = status.state;
    adaptersComponent = JSON.stringify(byBot);
  }

  return {
    ok: true,
    version: HOSTD_VERSION,
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    db: deps.db ? "connected" : "not-connected (menyusul fase 1)",
    components: { bus: busComponent, state: "stub", adapters: adaptersComponent, supervisors: "stub" },
  };
}
