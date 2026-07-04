import { describe, expect, test } from "bun:test";
import { doctorReport } from "../src/doctor";
import { openDb } from "../src/state/db";
import { enqueue } from "../src/bus/bus";
import type { EnvelopeT } from "@mirza-harness/shared";

describe("doctorReport (stub fase 0)", () => {
  test("bentuk payload lengkap — tanpa deps, perilaku lama tak berubah", () => {
    const r = doctorReport();
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.pid).toBe(process.pid);
    expect(r.uptime_s).toBeGreaterThanOrEqual(0);
    expect(r.db).toContain("fase 1");
    expect(Object.keys(r.components)).toEqual(["bus", "state", "adapters", "supervisors"]);
    expect(r.components.bus).toBe("stub");
  });
});

describe("doctorReport (deps.db — wiring bus stats)", () => {
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

  test("dengan db tersedia, komponen bus berisi busStats (bukan 'stub')", () => {
    const db = openDb(":memory:");
    enqueue(db, env());
    const r = doctorReport({ db });
    expect(r.db).toBe("connected");
    const stats = JSON.parse(r.components.bus);
    expect(stats.queued).toBe(1);
    expect(stats.dead).toBe(0);
    expect(stats.oldest_unacked_s).toBeGreaterThanOrEqual(0);
    db.close();
  });

  test("oldest_unacked_s dijepit (clamp) >= 0 walau ts caller-supplied di masa depan (deferred B1)", () => {
    const db = openDb(":memory:");
    const future = Math.floor(Date.now() / 1000) + 3600;
    enqueue(db, env({ ts: future }));
    const r = doctorReport({ db });
    const stats = JSON.parse(r.components.bus);
    expect(stats.oldest_unacked_s).toBeGreaterThanOrEqual(0);
    db.close();
  });
});
