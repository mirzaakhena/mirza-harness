import type { Database } from "bun:sqlite";
import { z } from "zod";
import { ChannelDeliverEvent } from "@mirza-harness/shared";
import { claimNext, ack, fail } from "./bus";

/**
 * LIMITATIONS (diketahui, belum diperbaiki di fase ini):
 *
 * (a) Restart hostd saat ada envelope in-flight: `inFlightByDb` (peta
 *     in-memory, `WeakMap<Database, Map<...>>`) dan timer confirm-nya
 *     hilang begitu proses hostd restart — TIDAK persisted. Pemulihan
 *     bergantung sepenuhnya pada `next_attempt_at` yang sudah ditulis ke
 *     bus_queue oleh `markInFlight` sebelum restart: begitu waktu itu
 *     lewat, `claimNext` akan meng-klaim ulang baris tsb sbg attempt baru
 *     (self-healing). Konsekuensinya, attempt yang hilang akibat restart
 *     TIDAK menambah kolom `attempts` (tak pernah sempat `fail()`) — jadi
 *     hitungan attempts di DB bisa lebih rendah dari jumlah percobaan
 *     pengiriman yang sebenarnya terjadi. Perilaku ini belum diuji test.
 *
 * (b) Pengiriman ke CC bersifat at-least-once, bukan exactly-once:
 *     notifikasi `channel.deliver` diteruskan ke Claude Code SEBELUM
 *     `channel.confirm` dikirim balik (lihat cc-stub/src/server.ts). Bila
 *     confirm gagal terkirim/diterima (mis. socket putus, hostd restart,
 *     atau timeout di sisi hostd) padahal notifikasi sudah sukses diterima
 *     CC, envelope akan di-retry dan CC bisa menerima pesan logis yang SAMA
 *     lebih dari sekali. Ini bisa diterima selama efek pemrosesan pesan
 *     idempotent (channel-inbound sekadar notifikasi/tampilan). Begitu D2
 *     menambahkan tools MCP ber-efek-samping (mis. tool yang menuliskan
 *     sesuatu / memicu aksi eksternal berdasar isi channel-inbound),
 *     idempotency di sisi consumer/tool jadi penting supaya duplikat
 *     akibat at-least-once ini tidak menyebabkan efek ganda.
 */

/** Interval tick default (ms) untuk loop delivery. */
const DEFAULT_INTERVAL_MS = 500;
/** Batas waktu default (ms) menunggu `channel.confirm` sebelum in-flight dianggap gagal. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 15_000;

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
  /**
   * Batas waktu (ms) menunggu `channel.confirm` dari cc-stub setelah push
   * berhasil sebelum envelope in-flight dianggap gagal (fail + retry
   * backoff). Injectable utk test; default 15000ms.
   */
  confirmTimeoutMs?: number;
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
 * Registry envelope in-flight (sudah dipush ke stub, menunggu
 * `channel.confirm`) — di-key PER instance `Database` (bukan satu peta
 * global) supaya test yang membuka banyak db (":memory:") terpisah tak
 * saling mengganggu timer/state satu sama lain.
 */
interface InFlightEntry {
  botId: string;
  claimedAt: number;
  /** Token unik attempt ini (lihat `markInFlight`) — dipakai `confirmDelivery` utk menolak stale confirm lintas attempt. */
  attemptToken: string;
  timer: ReturnType<typeof setTimeout>;
}
const inFlightByDb = new WeakMap<Database, Map<string, InFlightEntry>>();

function inFlightMap(db: Database): Map<string, InFlightEntry> {
  let m = inFlightByDb.get(db);
  if (!m) {
    m = new Map();
    inFlightByDb.set(db, m);
  }
  return m;
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

/**
 * Tandai envelope sbg in-flight: (a) dorong `next_attempt_at` envelope itu
 * ke depan supaya `claimNext` TIDAK meng-klaim ulang baris yang sama selagi
 * menunggu confirm (ini bukan kegagalan, jadi `attempts` TIDAK di-increment
 * — beda dari `fail()`), (b) pasang timer: bila `channel.confirm` tak
 * kunjung datang dalam `timeoutMs`, envelope dianggap gagal (fail +
 * retry/backoff normal — kegagalan harus terlihat, prinsip §2.5, bukan
 * silent-drop), (c) generate `attempt_token` (uuid) unik utk push INI dan
 * simpan di entry — dipakai `confirmDelivery` utk menolak confirm yang
 * merujuk attempt LAIN pada `envelope_id` yang sama (stale confirm lintas
 * attempt, mis. confirm attempt#1 yang telat tiba SETELAH attempt#1 sudah
 * timeout dan attempt#2 sudah in-flight — tanpa token per-attempt, confirm
 * telat itu bisa salah meng-ack attempt#2 yang belum benar-benar dikonfirmasi
 * oleh cc-stub).
 *
 * `next_attempt_at` di bus_queue bergranularitas DETIK (konsisten dgn
 * `fail()`/backoff bus-core yg selalu dlm detik) sedangkan `timeoutMs` dlm
 * milidetik dan boleh sub-detik (mis. utk test). Membulatkan-ke-bawah bisa
 * menghasilkan detik yg SAMA dgn sekarang (bukan strictly di masa depan),
 * membuat `claimNext` meng-klaim ulang baris ini SEBELUM timer in-flight
 * sempat berjalan (double delivery dlm tick yg sama). Maka selalu bulatkan
 * ke ATAS dan minimal 1 detik ke depan.
 *
 * `attemptToken` dibuat oleh pemanggil (`processOne`, SEBELUM push) supaya
 * bisa disertakan di params `channel.deliver` yang dikirim ke cc-stub —
 * di sini token itu hanya disimpan di entry in-flight utk dicocokkan nanti
 * oleh `confirmDelivery`.
 */
function markInFlight(db: Database, botId: string, envelopeId: string, timeoutMs: number, attemptToken: string): void {
  const m = inFlightMap(db);
  const claimedAt = Date.now();
  const guardS = Math.max(1, Math.ceil(timeoutMs / 1000));
  db.run(`UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?`, [
    Math.floor(claimedAt / 1000) + guardS,
    envelopeId,
  ]);
  const timer = setTimeout(() => {
    m.delete(envelopeId);
    fail(db, envelopeId, `channel.confirm tak diterima dalam ${timeoutMs}ms — envelope in-flight dianggap gagal (retry)`);
  }, timeoutMs);
  unref(timer);
  m.set(envelopeId, { botId, claimedAt, attemptToken, timer });
}

/**
 * Confirm balik dari cc-stub (dipanggil dari handler RPC `channel.confirm`
 * hostd/server.ts, lewat delegate yang di-inject via `registerConfirmHandler`).
 * Ack HANYA terjadi di sini — bukan lagi saat push socket berhasil (deviasi
 * lama sudah diperbaiki; lihat docstring `processOne`).
 *
 * `attemptToken` HARUS cocok dengan token entry in-flight yang aktif saat
 * ini utk `envelopeId` (lihat `markInFlight`) — bila entry tak ada ATAU
 * token tak cocok, ini adalah confirm STALE (mis. dari attempt sebelumnya
 * yang sudah timeout & di-requeue jadi attempt baru dgn token baru) dan
 * TIDAK di-ack: return `false` tanpa mengubah state, biarkan attempt yang
 * sedang aktif (bila ada) lanjut menunggu confirm-nya sendiri. Klaim
 * idempotensi sekarang akurat secara lintas-attempt: confirm telat tak bisa
 * lagi meng-ack attempt lain yang belum benar-benar dikonfirmasi.
 */
export function confirmDelivery(db: Database, envelopeId: string, attemptToken: string): boolean {
  const m = inFlightMap(db);
  const entry = m.get(envelopeId);
  if (!entry) return false;
  if (entry.attemptToken !== attemptToken) return false;
  clearTimeout(entry.timer);
  m.delete(envelopeId);
  return ack(db, envelopeId);
}

/**
 * Proses satu envelope terklaim untuk `botId`. Return `true` bila sesuatu
 * diproses (in-flight/fail), `false` bila tak ada baris siap-klaim
 * (pemanggil berhenti drain bot ini pada tick berjalan).
 *
 * Protokol confirm (sesuai brief penuh): push socket berhasil TIDAK lagi
 * berarti ack — envelope ditandai in-flight (`markInFlight`) dan baru
 * di-ack saat cc-stub membalas `channel.confirm {envelope_id}`
 * (`confirmDelivery`). Tanpa confirm dalam `confirmTimeoutMs`, envelope
 * di-fail (retry dgn backoff biasa).
 */
function processOne(db: Database, botId: string, deps: DeliveryDeps, stats: DeliveryStats, confirmTimeoutMs: number): boolean {
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
  // attempt_token dibuat SEBELUM push (via markInFlight) supaya bisa disertakan
  // di params channel.deliver — cc-stub membawanya balik di channel.confirm.
  const attemptToken = crypto.randomUUID();
  const pushParams = ChannelDeliverEvent.parse({ envelope_id: env.id, attempt_token: attemptToken, content, meta });
  const sent = deps.push(botId, "channel.deliver", pushParams);
  if (sent) {
    markInFlight(db, botId, env.id, confirmTimeoutMs, attemptToken);
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
export function deliverOnce(db: Database, deps: DeliveryDeps, opts: DeliveryOptions = {}): DeliveryStats {
  const stats: DeliveryStats = { delivered: 0, failed: 0 };
  const nowS = Math.floor(Date.now() / 1000);
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  for (const botId of claimableBotIds(db, nowS)) {
    while (processOne(db, botId, deps, stats, confirmTimeoutMs)) {
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
  const timer = setInterval(() => deliverOnce(db, deps, opts), intervalMs);
  // Jangan tahan proses hidup hanya krn timer ini (relevan utk test/CLI singkat).
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}
