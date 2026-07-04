import { describe, expect, test } from "bun:test";
import { openDb } from "../src/state/db";
import { enqueue, claimNext } from "../src/bus/bus";
import { deliverOnce, startDelivery, confirmDelivery, type DeliveryDeps } from "../src/bus/delivery";
import type { EnvelopeT } from "@mirza-harness/shared";

function env(overrides: Partial<EnvelopeT> = {}): EnvelopeT {
  return {
    id: crypto.randomUUID(),
    ts: Math.floor(Date.now() / 1000),
    from: "bot-01",
    to: "cc-stub-01",
    kind: "channel-inbound",
    payload: { content: "halo dari telegram", meta: { channel: "telegram", chat_id: "123" } },
    hop: 0,
    ...overrides,
  };
}

interface PushedCall {
  botId: string;
  method: string;
  params: unknown;
}

/** Ambil `attempt_token` dari params channel.deliver yang ditangkap fakeDeps. */
function attemptTokenOf(call: PushedCall): string {
  return (call.params as { attempt_token: string }).attempt_token;
}

function fakeDeps(overrides: Partial<DeliveryDeps> = {}): { deps: DeliveryDeps; pushed: PushedCall[] } {
  const pushed: PushedCall[] = [];
  const deps: DeliveryDeps = {
    isRegistered: () => true,
    push: (botId, method, params) => {
      pushed.push({ botId, method, params });
      return true;
    },
    ...overrides,
  };
  return { deps, pushed };
}

describe("deliverOnce — sukses", () => {
  test("envelope valid + stub online -> push terpanggil, in-flight sampai channel.confirm", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    const stats = deliverOnce(db, deps);

    expect(stats.delivered).toBe(1);
    expect(stats.failed).toBe(0);
    expect(pushed.length).toBe(1);
    expect(pushed[0].botId).toBe(e.to);
    expect(pushed[0].method).toBe("channel.deliver");
    expect(pushed[0].params).toEqual({
      envelope_id: e.id,
      attempt_token: expect.any(String),
      content: "halo dari telegram",
      meta: { channel: "telegram", chat_id: "123" },
    });

    // push berhasil BUKAN berarti ack lagi (protokol confirm) — masih in-flight,
    // dan tak lagi claimable selagi menunggu confirm.
    expect(claimNext(db, e.to)).toBeNull();
    let row = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number | null };
    expect(row.acked_at).toBeNull();

    // channel.confirm datang -> baru di-ack di sini.
    const confirmed = confirmDelivery(db, e.id, attemptTokenOf(pushed[0]));
    expect(confirmed).toBe(true);
    row = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number };
    expect(row.acked_at).toBeGreaterThan(0);
    db.close();
  });

  test("kind 'prompt' juga diproses (bukan hanya channel-inbound)", () => {
    const db = openDb(":memory:");
    const e = env({ kind: "prompt", payload: { content: "prompt text", meta: {} } });
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    deliverOnce(db, deps);

    expect(pushed.length).toBe(1);
    db.close();
  });
});

describe("deliverOnce — stub offline lalu retry", () => {
  test("offline -> fail (backoff terjadwal), online kemudian -> retry sukses -> ack", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);

    let online = false;
    const { deps, pushed } = fakeDeps({
      isRegistered: () => online,
      push: (botId, method, params) => {
        if (!online) return false;
        pushed.push({ botId, method, params });
        return true;
      },
    });

    // Tick 1: stub offline -> fail, attempts=1, next_attempt_at di masa depan.
    const stats1 = deliverOnce(db, deps);
    expect(stats1.delivered).toBe(0);
    expect(stats1.failed).toBe(1);
    expect(pushed.length).toBe(0);

    const rowAfterFail = db.query("SELECT attempts, next_attempt_at, acked_at FROM bus_queue WHERE id = ?").get(e.id) as {
      attempts: number;
      next_attempt_at: number;
      acked_at: number | null;
    };
    expect(rowAfterFail.attempts).toBe(1);
    expect(rowAfterFail.acked_at).toBeNull();
    expect(rowAfterFail.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Tick 2 (segera): masih dalam window backoff -> tak diklaim -> tak ada perubahan.
    const stats2 = deliverOnce(db, deps);
    expect(stats2.delivered).toBe(0);
    expect(stats2.failed).toBe(0);

    // Stub online, paksa next_attempt_at ke masa lalu (simulasi waktu retry tiba).
    online = true;
    const past = Math.floor(Date.now() / 1000) - 1;
    db.run("UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?", [past, e.id]);

    const stats3 = deliverOnce(db, deps);
    expect(stats3.delivered).toBe(1);
    expect(pushed.length).toBe(1);

    // in-flight setelah push sukses — belum ack sampai confirm datang.
    const rowInFlight = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number | null };
    expect(rowInFlight.acked_at).toBeNull();

    expect(confirmDelivery(db, e.id, attemptTokenOf(pushed[0]))).toBe(true);
    const rowAfterAck = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number };
    expect(rowAfterAck.acked_at).toBeGreaterThan(0);
    db.close();
  });

  test("registered tapi push gagal -> fail dgn reason menyebut push gagal, envelope tak acked", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps({
      isRegistered: () => true,
      push: () => false,
    });

    const stats = deliverOnce(db, deps);

    expect(stats.failed).toBe(1);
    expect(stats.delivered).toBe(0);
    expect(pushed.length).toBe(0);

    // Verifikasi envelope still unacked
    const row = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number | null };
    expect(row.acked_at).toBeNull();

    // Verifikasi reason menyebut push gagal
    const dead = db.query("SELECT reason FROM bus_dead WHERE id = ?").get(e.id) as { reason: string } | null;
    // Pada attempt pertama yang gagal, reason disimpan di bus_queue sebagai fail history,
    // ini akan ke bus_dead setelah max attempts. Cek bahwa baris di-mark failed dengan reason push gagal.
    const failRow = db.query("SELECT next_attempt_at FROM bus_queue WHERE id = ?").get(e.id) as { next_attempt_at: number };
    expect(failRow.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    db.close();
  });
});

describe("deliverOnce — meta non-string (SCAR-056)", () => {
  test("meta berisi nilai non-string -> fail dgn reason menyebut SCAR-056, push tak pernah terpanggil", () => {
    const db = openDb(":memory:");
    // payload di Envelope bertipe unknown — meta.count sengaja number (bukan string) utk uji SCAR-056.
    const e = env({ payload: { content: "x", meta: { channel: "telegram", count: 5 } } });
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    // Dorong sampai dead-letter (8 percobaan) supaya reason bisa diverifikasi
    // lewat bus_dead — bus_queue sendiri tak menyimpan reason per-attempt.
    for (let i = 0; i < 8; i++) {
      deliverOnce(db, deps);
      const past = Math.floor(Date.now() / 1000) - 1;
      db.run("UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?", [past, e.id]);
    }

    expect(pushed.length).toBe(0);
    const dead = db.query("SELECT reason FROM bus_dead WHERE id = ?").get(e.id) as { reason: string } | null;
    expect(dead).not.toBeNull();
    expect(dead!.reason).toContain("SCAR-056");
    db.close();
  });

  test("payload tanpa 'content' string juga ditolak sebelum push", () => {
    const db = openDb(":memory:");
    const e = env({ payload: { meta: { a: "b" } } });
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    const stats = deliverOnce(db, deps);
    expect(stats.failed).toBe(1);
    expect(pushed.length).toBe(0);
    db.close();
  });
});

describe("deliverOnce — urutan FIFO", () => {
  test("dua envelope utk bot yang sama dikirim ter-tua (ts) lebih dulu, keduanya di-push dalam satu tick", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    const older = env({ ts: now - 100, payload: { content: "pertama", meta: {} } });
    const newer = env({ ts: now - 10, payload: { content: "kedua", meta: {} } });
    enqueue(db, newer); // insert urutan dibalik sengaja
    enqueue(db, older);

    const { deps, pushed } = fakeDeps();
    const stats = deliverOnce(db, deps);

    expect(stats.delivered).toBe(2);
    expect(pushed.length).toBe(2);
    expect(pushed[0].params).toEqual({ envelope_id: older.id, attempt_token: expect.any(String), content: "pertama", meta: {} });
    expect(pushed[1].params).toEqual({ envelope_id: newer.id, attempt_token: expect.any(String), content: "kedua", meta: {} });
    db.close();
  });

  test("bot berbeda tak saling mengganggu urutan", () => {
    const db = openDb(":memory:");
    const forA = env({ to: "cc-stub-a" });
    const forB = env({ to: "cc-stub-b" });
    enqueue(db, forA);
    enqueue(db, forB);

    const { deps, pushed } = fakeDeps();
    deliverOnce(db, deps);

    expect(pushed.map(p => p.botId).sort()).toEqual(["cc-stub-a", "cc-stub-b"]);
    db.close();
  });
});

describe("protokol confirm — in-flight, timeout, retry", () => {
  test("push sukses tapi channel.confirm tak pernah datang -> timeout -> fail (retry terjadwal), tak pernah ack", async () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    const stats = deliverOnce(db, deps, { confirmTimeoutMs: 20 });
    expect(stats.delivered).toBe(1);
    expect(pushed.length).toBe(1);

    const rowBeforeTimeout = db.query("SELECT acked_at, attempts FROM bus_queue WHERE id = ?").get(e.id) as {
      acked_at: number | null;
      attempts: number;
    };
    expect(rowBeforeTimeout.acked_at).toBeNull();
    expect(rowBeforeTimeout.attempts).toBe(0);

    // lewati timeout confirm
    await new Promise(resolve => setTimeout(resolve, 80));

    const rowAfterTimeout = db.query("SELECT acked_at, attempts, next_attempt_at FROM bus_queue WHERE id = ?").get(e.id) as {
      acked_at: number | null;
      attempts: number;
      next_attempt_at: number;
    };
    expect(rowAfterTimeout.acked_at).toBeNull();
    expect(rowAfterTimeout.attempts).toBe(1);
    expect(rowAfterTimeout.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // confirm telat (setelah timeout) -> tak berpengaruh, entry in-flight sudah dibuang oleh timeout
    expect(confirmDelivery(db, e.id, attemptTokenOf(pushed[0]))).toBe(false);
    db.close();
  });

  test("channel.confirm datang sebelum timeout -> ack, timeout yang terjadwal tak lagi memicu fail susulan", async () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    deliverOnce(db, deps, { confirmTimeoutMs: 50 });
    expect(confirmDelivery(db, e.id, attemptTokenOf(pushed[0]))).toBe(true);

    // lewati window timeout yang SEHARUSNYA sudah dibatalkan oleh confirmDelivery
    await new Promise(resolve => setTimeout(resolve, 90));

    const row = db.query("SELECT acked_at, attempts FROM bus_queue WHERE id = ?").get(e.id) as {
      acked_at: number;
      attempts: number;
    };
    expect(row.acked_at).toBeGreaterThan(0);
    expect(row.attempts).toBe(0);
    db.close();
  });

  test("confirmDelivery utk envelope_id tak dikenal -> false, tak melempar", () => {
    const db = openDb(":memory:");
    expect(confirmDelivery(db, "envelope-tak-ada", "token-tak-relevan")).toBe(false);
    db.close();
  });

  test("stale confirm lintas attempt: confirm attempt#1 (telat, post-timeout) TIDAK boleh meng-ack attempt#2 yang in-flight", async () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    // Attempt#1: push, lalu biarkan timeout (tanpa confirm) -> fail + retry terjadwal.
    const stats1 = deliverOnce(db, deps, { confirmTimeoutMs: 20 });
    expect(stats1.delivered).toBe(1);
    expect(pushed.length).toBe(1);
    const token1 = attemptTokenOf(pushed[0]);

    await new Promise(resolve => setTimeout(resolve, 80)); // lewati timeout confirm attempt#1

    const rowAfterTimeout = db.query("SELECT acked_at, attempts, next_attempt_at FROM bus_queue WHERE id = ?").get(e.id) as {
      acked_at: number | null;
      attempts: number;
      next_attempt_at: number;
    };
    expect(rowAfterTimeout.acked_at).toBeNull();
    expect(rowAfterTimeout.attempts).toBe(1);

    // Paksa next_attempt_at ke masa lalu supaya attempt#2 bisa segera diklaim (simulasi waktu retry tiba).
    const past = Math.floor(Date.now() / 1000) - 1;
    db.run("UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?", [past, e.id]);

    // Attempt#2: requeue -> push lagi, in-flight dgn token BARU.
    const stats2 = deliverOnce(db, deps, { confirmTimeoutMs: 20_000 });
    expect(stats2.delivered).toBe(1);
    expect(pushed.length).toBe(2);
    const token2 = attemptTokenOf(pushed[1]);
    expect(token2).not.toBe(token1);

    // Confirm telat dari attempt#1 tiba SEKARANG (setelah attempt#2 sudah in-flight) -> HARUS ditolak (stale),
    // dan TIDAK boleh meng-ack attempt#2 yang belum benar-benar dikonfirmasi.
    expect(confirmDelivery(db, e.id, token1)).toBe(false);
    const rowAfterStaleConfirm = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number | null };
    expect(rowAfterStaleConfirm.acked_at).toBeNull();

    // Confirm yang benar (token attempt#2) -> ack sukses.
    expect(confirmDelivery(db, e.id, token2)).toBe(true);
    const rowAfterRealConfirm = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number };
    expect(rowAfterRealConfirm.acked_at).toBeGreaterThan(0);
    db.close();
  });
});

describe("startDelivery — loop interval", () => {
  test("tick otomatis mengirim envelope yang sudah antre tanpa perlu deliverOnce manual", async () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const { deps, pushed } = fakeDeps();

    const handle = startDelivery(db, deps, { intervalMs: 15 });
    await new Promise(resolve => setTimeout(resolve, 100));
    handle.stop();

    expect(pushed.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
