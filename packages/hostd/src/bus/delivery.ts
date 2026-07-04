import type { Database } from "bun:sqlite";
import { z } from "zod";
import { claimNext, ack, fail } from "./bus";

/** Interval tick default (ms) untuk loop delivery. */
const DEFAULT_INTERVAL_MS = 500;

/**
 * Payload envelope bus yang ditujukan ke cc-stub (kind `channel-inbound`
 * atau `prompt`). `meta` WAJIB `Record<string,string>` — nilai non-string
 * (mis. angka/boolean/objek) ditolak di sini SEBELUM di-push, supaya
 * kesalahan bentuk data (SCAR-056) jadi kegagalan bus TERLIHAT (fail +
 * retry/dead-letter), bukan drop senyap atau korupsi data di sisi cc-stub.
 */
const ChannelDeliverPayload = z.object({
  content: z.string(),
  meta: z.record(z.string(), z.string()),
});

export interface DeliveryDeps {
  /** Apakah bot_id punya koneksi cc-stub terdaftar saat ini (dipakai untuk memperjelas alasan gagal). */
  isRegistered: (botId: string) => boolean;
  /** Kirim event `method`/`params` ke cc-stub botId; `false` bila gagal/offline. */
  push: (botId: string, method: string, params: unknown) => boolean;
}

export interface DeliveryOptions {
  /** Interval tick (ms). Default 500ms. */
  intervalMs?: number;
}

export interface DeliveryStats {
  delivered: number;
  failed: number;
}

interface QueuedTarget {
  to_agent: string;
}

/** Ambil daftar bot (to_agent) yang punya baris siap-klaim di bus_queue saat ini. */
function claimableBotIds(db: Database, nowS: number): string[] {
  const rows = db
    .query(
      `SELECT DISTINCT to_agent FROM bus_queue
       WHERE acked_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    )
    .all(nowS) as QueuedTarget[];
  return rows.map(r => r.to_agent);
}

/**
 * Proses satu envelope terklaim untuk `botId`. Return `true` bila sesuatu
 * diproses (ack atau fail), `false` bila tak ada baris siap-klaim (pemanggil
 * berhenti drain bot ini pada tick berjalan).
 *
 * DEVIASI DARI BRIEF:
 * Saat ini ack terjadi setelah write ke socket stub BERHASIL, BELUM menunggu
 * konfirmasi balik dari cc-stub (cc-stub belum ada protokol confirm eksplisit
 * untuk acknowledge delivery). Follow-up di task assembly D1: implementasi
 * protokol confirm balik sebelum mengirim ack (delivery masih "in-flight" pada
 * tahap ini).
 */
function processOne(db: Database, botId: string, deps: DeliveryDeps, stats: DeliveryStats): boolean {
  const env = claimNext(db, botId);
  if (!env) return false;

  const parsed = ChannelDeliverPayload.safeParse(env.payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    fail(db, env.id, `SCAR-056: payload channel.deliver tak valid (meta bukan Record<string,string>) — ${detail}`);
    stats.failed++;
    return true;
  }

  const { content, meta } = parsed.data;
  const sent = deps.push(botId, "channel.deliver", { content, meta });
  if (sent) {
    ack(db, env.id);
    stats.delivered++;
  } else {
    const reason = deps.isRegistered(botId)
      ? "push ke cc-stub gagal (koneksi terdaftar tapi kirim gagal)"
      : "stub offline: belum ada koneksi cc-stub terdaftar utk bot ini";
    fail(db, env.id, reason);
    stats.failed++;
  }
  return true;
}

/**
 * Satu tick delivery: untuk tiap bot yang punya baris siap-klaim di
 * bus_queue, kuras (drain) semua baris yang due saat ini secara FIFO
 * (claimNext selalu mengembalikan ts ter-tua lebih dulu). Aman dari
 * infinite-loop: `fail` menjadwalkan next_attempt_at di masa depan
 * (backoff bus-core), sehingga baris yang baru gagal tak lagi diklaim pada
 * tick yang sama.
 */
export function deliverOnce(db: Database, deps: DeliveryDeps): DeliveryStats {
  const stats: DeliveryStats = { delivered: 0, failed: 0 };
  const nowS = Math.floor(Date.now() / 1000);
  for (const botId of claimableBotIds(db, nowS)) {
    while (processOne(db, botId, deps, stats)) {
      // drain semua baris due utk bot ini pada tick berjalan
    }
  }
  return stats;
}

export interface DeliveryHandle {
  stop(): void;
}

/** Mulai loop delivery berkala (default 500ms). Panggil `.stop()` utk berhenti. */
export function startDelivery(db: Database, deps: DeliveryDeps, opts: DeliveryOptions = {}): DeliveryHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => deliverOnce(db, deps), intervalMs);
  // Jangan tahan proses hidup hanya krn timer ini (relevan utk test/CLI singkat).
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}
