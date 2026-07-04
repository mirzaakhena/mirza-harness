import type { Database } from "bun:sqlite";
import { Envelope, type EnvelopeT } from "@mirza-harness/shared";

/** Backoff basis (detik) untuk kegagalan pertama; dobel tiap kegagalan berikutnya. */
const BASE_BACKOFF_S = 5;
/** Batas atas backoff (5 menit). */
const MAX_BACKOFF_S = 300;
/** Ambang attempts untuk memindahkan envelope ke bus_dead. */
const MAX_ATTEMPTS = 8;

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

interface BusQueueRow {
  id: string;
  ts: number;
  from_agent: string;
  to_agent: string;
  kind: string;
  payload: string;
  hop: number;
  reply_to: string | null;
  attempts: number;
}

function rowToEnvelope(row: BusQueueRow): EnvelopeT {
  return {
    id: row.id,
    ts: row.ts,
    from: row.from_agent,
    to: row.to_agent,
    kind: row.kind as EnvelopeT["kind"],
    payload: JSON.parse(row.payload),
    hop: row.hop,
    ...(row.reply_to != null ? { reply_to: row.reply_to } : {}),
  };
}

/**
 * Masukkan envelope ke bus_queue setelah validasi zod (lempar bila skema
 * tak cocok — konsisten dgn parseRpcMessage di shared/ipc.ts). Idempotent
 * by id: bila id sudah ada, tidak melakukan apa-apa dan mengembalikan
 * `false`; insert baru mengembalikan `true`.
 */
export function enqueue(db: Database, env: EnvelopeT): boolean {
  const parsed = Envelope.parse(env);
  const result = db.run(
    `INSERT OR IGNORE INTO bus_queue (id, ts, from_agent, to_agent, kind, payload, hop, reply_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      parsed.id,
      parsed.ts,
      parsed.from,
      parsed.to,
      parsed.kind,
      JSON.stringify(parsed.payload),
      parsed.hop,
      parsed.reply_to ?? null,
    ],
  );
  return result.changes > 0;
}

/**
 * Ambil (tanpa mengunci) baris unacked ter-tua untuk `to` yang siap
 * diproses — `next_attempt_at` NULL atau sudah lewat. Konsumen wajib
 * memanggil `ack` atau `fail` setelah memproses. `null` bila tak ada baris
 * siap.
 *
 * LIMITATIONS YANG TERDOKUMENTASI:
 * (a) Tidak ada visibility-lock (no database-level row lock). Setiap claimNext
 *     hanya membaca tanpa `FOR UPDATE`, sehingga status "sedang diproses"
 *     tidak ditandai ke database.
 * (b) Asumsi single-consumer per `to`: Kode ini berasumsi hanya satu konsumen
 *     (goroutine/thread) memanggil claimNext untuk setiap `to` agent pada
 *     waktu yang sama.
 * (c) Race condition konkret: Bila dua claimNext dipanggil bersamaan untuk
 *     `to` yang sama SEBELUM salah satunya memanggil ack() atau fail(), kedua
 *     akan mengembalikan baris yang SAMA (id identik, envelope identik).
 *     Akibatnya: (i) pemrosesan ganda, (ii) ack/fail kedua boleh-boleh saja
 *     (idempotent), tapi (iii) jika keduanya meng-ack, yang kedua return false.
 * (d) Jalur perluasan ke depan: Untuk mencegah claim-ganda, dapat ditambahkan
 *     kolom `claimed_at` + waktu timeout, lalu claimNext skip baris yang sudah
 *     diklaim tapi belum di-ack/fail dalam timeout window (hint: timeout ~1 menit).
 */
export function claimNext(db: Database, to: string): EnvelopeT | null {
  const row = db
    .query(
      `SELECT id, ts, from_agent, to_agent, kind, payload, hop, reply_to, attempts
       FROM bus_queue
       WHERE to_agent = ? AND acked_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY ts ASC, id ASC
       LIMIT 1`,
    )
    .get(to, nowS()) as BusQueueRow | null;
  if (!row) return null;
  return rowToEnvelope(row);
}

/**
 * Tandai envelope sebagai acked. Idempotent: id yang tak ada (atau sudah
 * acked) mengembalikan `false` tanpa melempar.
 */
export function ack(db: Database, id: string): boolean {
  const result = db.run(`UPDATE bus_queue SET acked_at = ? WHERE id = ? AND acked_at IS NULL`, [nowS(), id]);
  return result.changes > 0;
}

/**
 * Catat kegagalan pengiriman: attempts+1, lalu jadwalkan retry berikutnya
 * dgn backoff eksponensial (basis 5 detik, x2 tiap percobaan, cap 5 menit).
 * Setelah attempts mencapai 8, envelope dipindahkan utuh ke bus_dead
 * (kolom `envelope` berisi JSON envelope, `reason` berisi alasan kegagalan
 * terakhir) dan baris di bus_queue dihapus. id yang tak ada -> no-op.
 */
export function fail(db: Database, id: string, reason: string): void {
  const row = db
    .query(
      `SELECT id, ts, from_agent, to_agent, kind, payload, hop, reply_to, attempts
       FROM bus_queue WHERE id = ?`,
    )
    .get(id) as BusQueueRow | null;
  if (!row) return;

  const attempts = row.attempts + 1;

  if (attempts >= MAX_ATTEMPTS) {
    const envelope = rowToEnvelope(row);
    db.run(`INSERT OR REPLACE INTO bus_dead (id, ts, envelope, reason, dead_at) VALUES (?, ?, ?, ?, ?)`, [
      row.id,
      row.ts,
      JSON.stringify(envelope),
      reason,
      nowS(),
    ]);
    db.run(`DELETE FROM bus_queue WHERE id = ?`, [id]);
    return;
  }

  const backoffS = Math.min(BASE_BACKOFF_S * 2 ** (attempts - 1), MAX_BACKOFF_S);
  db.run(`UPDATE bus_queue SET attempts = ?, next_attempt_at = ? WHERE id = ?`, [
    attempts,
    nowS() + backoffS,
    id,
  ]);
}

export interface BusStats {
  queued: number;
  dead: number;
  oldest_unacked_s: number;
}

/** Ringkasan status bus untuk doctorReport: jumlah antre, jumlah mati, umur baris unacked tertua (detik). */
export function busStats(db: Database): BusStats {
  const queuedRow = db.query(`SELECT COUNT(*) as c FROM bus_queue WHERE acked_at IS NULL`).get() as { c: number };
  const deadRow = db.query(`SELECT COUNT(*) as c FROM bus_dead`).get() as { c: number };
  const oldestRow = db.query(`SELECT MIN(ts) as m FROM bus_queue WHERE acked_at IS NULL`).get() as {
    m: number | null;
  };
  const oldest_unacked_s = oldestRow.m != null ? nowS() - oldestRow.m : 0;
  return { queued: queuedRow.c, dead: deadRow.c, oldest_unacked_s };
}
