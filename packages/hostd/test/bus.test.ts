import { describe, expect, test } from "bun:test";
import { openDb } from "../src/state/db";
import { enqueue, claimNext, ack, fail, busStats } from "../src/bus/bus";
import type { EnvelopeT } from "@mirza-harness/shared";

function env(overrides: Partial<EnvelopeT> = {}): EnvelopeT {
  return {
    id: crypto.randomUUID(),
    ts: Math.floor(Date.now() / 1000),
    from: "bot-01",
    to: "bot-02",
    kind: "prompt",
    payload: { text: "halo" },
    hop: 0,
    ...overrides,
  };
}

describe("enqueue", () => {
  test("insert envelope baru -> true, baris muncul di bus_queue", () => {
    const db = openDb(":memory:");
    const e = env();
    expect(enqueue(db, e)).toBe(true);
    const row = db.query("SELECT id, from_agent, to_agent, kind, hop FROM bus_queue WHERE id = ?").get(e.id) as Record<string, unknown>;
    expect(row.id).toBe(e.id);
    expect(row.from_agent).toBe(e.from);
    expect(row.to_agent).toBe(e.to);
    expect(row.kind).toBe(e.kind);
    expect(row.hop).toBe(e.hop);
    db.close();
  });

  test("id duplikat -> no-op, return false, tidak ada baris kedua", () => {
    const db = openDb(":memory:");
    const e = env();
    expect(enqueue(db, e)).toBe(true);
    expect(enqueue(db, e)).toBe(false);
    const rows = db.query("SELECT id FROM bus_queue WHERE id = ?").all(e.id);
    expect(rows.length).toBe(1);
    db.close();
  });

  test("payload disimpan sebagai JSON dan bisa dibaca balik lewat claimNext", () => {
    const db = openDb(":memory:");
    const e = env({ payload: { nested: { a: 1, b: [1, 2, 3] } } });
    enqueue(db, e);
    const claimed = claimNext(db, e.to);
    expect(claimed?.payload).toEqual(e.payload);
    db.close();
  });

  test("envelope tak valid ditolak (dilempar oleh validasi zod)", () => {
    const db = openDb(":memory:");
    // @ts-expect-error sengaja kirim kind invalid untuk uji validasi runtime
    expect(() => enqueue(db, env({ kind: "bogus" }))).toThrow();
    db.close();
  });
});

describe("claimNext — urutan", () => {
  test("mengembalikan baris unacked ter-tua (ts terkecil) lebih dulu", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    const older = env({ ts: now - 100 });
    const newer = env({ ts: now - 10 });
    enqueue(db, newer);
    enqueue(db, older);
    const claimed = claimNext(db, "bot-02");
    expect(claimed?.id).toBe(older.id);
    db.close();
  });

  test("mengembalikan null bila tidak ada baris siap", () => {
    const db = openDb(":memory:");
    expect(claimNext(db, "bot-99")).toBeNull();
    db.close();
  });

  test("hanya mengembalikan baris untuk 'to' yang diminta", () => {
    const db = openDb(":memory:");
    const forOther = env({ to: "bot-03" });
    enqueue(db, forOther);
    expect(claimNext(db, "bot-02")).toBeNull();
    expect(claimNext(db, "bot-03")?.id).toBe(forOther.id);
    db.close();
  });

  test("baris dengan next_attempt_at di masa depan tidak diklaim", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.run("UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?", [future, e.id]);
    expect(claimNext(db, e.to)).toBeNull();
    db.close();
  });

  test("baris dengan next_attempt_at yang sudah lewat bisa diklaim", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const past = Math.floor(Date.now() / 1000) - 10;
    db.run("UPDATE bus_queue SET next_attempt_at = ? WHERE id = ?", [past, e.id]);
    expect(claimNext(db, e.to)?.id).toBe(e.id);
    db.close();
  });

  test("baris yang sudah acked tidak lagi diklaim", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    ack(db, e.id);
    expect(claimNext(db, e.to)).toBeNull();
    db.close();
  });

  test("claimNext single-consumer: dua claim berturut tanpa ack mengembalikan baris yang sama — limitasi terdokumentasi", () => {
    // Dokumentasi claimNext menjelaskan bahwa tanpa visibility-lock di database,
    // asumsi single-consumer per `to` diperlukan. Limitasi ini ditest untuk
    // mengunci perilaku saat ini: bila dua claimNext dipanggil bersamaan untuk
    // `to` yang sama SEBELUM ack(), keduanya mengembalikan envelope identik.
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const claimed1 = claimNext(db, e.to);
    const claimed2 = claimNext(db, e.to);
    expect(claimed1).not.toBeNull();
    expect(claimed2).not.toBeNull();
    expect(claimed1?.id).toBe(claimed2?.id); // baris sama
    expect(claimed1?.payload).toEqual(claimed2?.payload); // envelope identik
    // Kalau keduanya memanggil ack:
    const ack1 = ack(db, claimed1!.id);
    const ack2 = ack(db, claimed2!.id);
    expect(ack1).toBe(true); // ack pertama berhasil
    expect(ack2).toBe(false); // ack kedua gagal (sudah acked)
    db.close();
  });
});

describe("ack", () => {
  test("menandai acked_at, return true bila baris ditemukan", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    expect(ack(db, e.id)).toBe(true);
    const row = db.query("SELECT acked_at FROM bus_queue WHERE id = ?").get(e.id) as { acked_at: number };
    expect(row.acked_at).toBeGreaterThan(0);
    db.close();
  });

  test("ack id yang tak ada -> return false, tak throw", () => {
    const db = openDb(":memory:");
    expect(ack(db, "tak-ada")).toBe(false);
    db.close();
  });
});

describe("fail — backoff eksponensial", () => {
  function nextAttemptAt(db: ReturnType<typeof openDb>, id: string): number {
    const row = db.query("SELECT next_attempt_at FROM bus_queue WHERE id = ?").get(id) as { next_attempt_at: number };
    return row.next_attempt_at;
  }
  function attempts(db: ReturnType<typeof openDb>, id: string): number {
    const row = db.query("SELECT attempts FROM bus_queue WHERE id = ?").get(id) as { attempts: number };
    return row.attempts;
  }

  test("basis 5 detik pada kegagalan pertama", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const before = Math.floor(Date.now() / 1000);
    fail(db, e.id, "timeout");
    expect(attempts(db, e.id)).toBe(1);
    const delta = nextAttemptAt(db, e.id) - before;
    expect(delta).toBeGreaterThanOrEqual(4);
    expect(delta).toBeLessThanOrEqual(6);
    db.close();
  });

  test("naik dua kali lipat tiap kegagalan berikutnya (5,10,20,...)", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    const expected = [5, 10, 20, 40, 80, 160, 300];
    for (let i = 0; i < expected.length; i++) {
      const before = Math.floor(Date.now() / 1000);
      fail(db, e.id, "timeout");
      const delta = nextAttemptAt(db, e.id) - before;
      expect(delta).toBeGreaterThanOrEqual(expected[i] - 1);
      expect(delta).toBeLessThanOrEqual(expected[i] + 1);
    }
    db.close();
  });

  test("cap pada 300 detik (5 menit) walau eksponen lebih besar", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    for (let i = 0; i < 6; i++) fail(db, e.id, "timeout"); // attempts jadi 6
    const before = Math.floor(Date.now() / 1000);
    fail(db, e.id, "timeout"); // attempts jadi 7 -> 5*2^6=320, capped 300
    const delta = nextAttemptAt(db, e.id) - before;
    expect(delta).toBeLessThanOrEqual(301);
    expect(delta).toBeGreaterThanOrEqual(299);
    db.close();
  });
});

describe("fail — dead-letter setelah 8 percobaan", () => {
  test("attempts >= 8 -> pindah ke bus_dead dengan reason, hilang dari bus_queue", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    for (let i = 0; i < 7; i++) fail(db, e.id, "timeout"); // attempts 1..7, masih di bus_queue
    let row = db.query("SELECT id FROM bus_queue WHERE id = ?").get(e.id);
    expect(row).not.toBeNull();
    fail(db, e.id, "final failure"); // attempts jadi 8 -> dead-letter
    row = db.query("SELECT id FROM bus_queue WHERE id = ?").get(e.id);
    expect(row).toBeNull();
    const dead = db.query("SELECT id, reason FROM bus_dead WHERE id = ?").get(e.id) as { id: string; reason: string };
    expect(dead.id).toBe(e.id);
    expect(dead.reason).toBe("final failure");
    db.close();
  });

  test("envelope tersimpan utuh di bus_dead.envelope sebagai JSON", () => {
    const db = openDb(":memory:");
    const e = env({ payload: { foo: "bar" } });
    enqueue(db, e);
    for (let i = 0; i < 8; i++) fail(db, e.id, "gagal terus");
    const dead = db.query("SELECT envelope FROM bus_dead WHERE id = ?").get(e.id) as { envelope: string };
    const parsed = JSON.parse(dead.envelope);
    expect(parsed.id).toBe(e.id);
    expect(parsed.payload).toEqual(e.payload);
    db.close();
  });

  test("setelah dead-letter, claimNext tidak lagi mengembalikannya", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    for (let i = 0; i < 8; i++) fail(db, e.id, "timeout");
    expect(claimNext(db, e.to)).toBeNull();
    db.close();
  });

  test("fail pada id yang tak ada -> no-op, tak throw", () => {
    const db = openDb(":memory:");
    expect(() => fail(db, "tak-ada", "reason")).not.toThrow();
    db.close();
  });
});

describe("busStats", () => {
  test("queued menghitung baris unacked di bus_queue", () => {
    const db = openDb(":memory:");
    enqueue(db, env());
    enqueue(db, env());
    const acked = env();
    enqueue(db, acked);
    ack(db, acked.id);
    const stats = busStats(db);
    expect(stats.queued).toBe(2);
    db.close();
  });

  test("dead menghitung baris di bus_dead", () => {
    const db = openDb(":memory:");
    const e = env();
    enqueue(db, e);
    for (let i = 0; i < 8; i++) fail(db, e.id, "timeout");
    const stats = busStats(db);
    expect(stats.dead).toBe(1);
    expect(stats.queued).toBe(0);
    db.close();
  });

  test("oldest_unacked_s mendekati usia baris unacked tertua", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    enqueue(db, env({ ts: now - 50 }));
    enqueue(db, env({ ts: now - 5 }));
    const stats = busStats(db);
    expect(stats.oldest_unacked_s).toBeGreaterThanOrEqual(48);
    expect(stats.oldest_unacked_s).toBeLessThanOrEqual(52);
    db.close();
  });

  test("oldest_unacked_s = 0 bila tidak ada baris unacked", () => {
    const db = openDb(":memory:");
    const stats = busStats(db);
    expect(stats.oldest_unacked_s).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.dead).toBe(0);
    db.close();
  });
});
