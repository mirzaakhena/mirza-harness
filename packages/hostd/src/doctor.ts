import type { Database } from "bun:sqlite";
import { busStats } from "./bus/bus";

export const HOSTD_VERSION = "0.0.1";

export interface DoctorReport {
  ok: boolean;
  version: string;
  pid: number;
  uptime_s: number;
  db: string;
  components: Record<string, string>;
}

export interface DoctorDeps {
  /** Bila ada, komponen `bus` dilaporkan dari busStats(db) alih-alih "stub". */
  db?: Database;
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
    busComponent = JSON.stringify(clamped);
  }

  return {
    ok: true,
    version: HOSTD_VERSION,
    pid: process.pid,
    uptime_s: Math.floor(process.uptime()),
    db: deps.db ? "connected" : "not-connected (menyusul fase 1)",
    components: { bus: busComponent, state: "stub", adapters: "stub", supervisors: "stub" },
  };
}
