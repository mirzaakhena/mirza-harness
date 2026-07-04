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

describe("doctorReport (Task D2 — adapterStatuses + deliveryStats wiring)", () => {
  test("adapterStatuses -> komponen adapters berisi {botId: pollerState}, bukan 'stub'", () => {
    const r = doctorReport({ adapterStatuses: new Map([["bot-01", { state: "running" }], ["bot-02", { state: "degraded" }]]) });
    expect(JSON.parse(r.components.adapters)).toEqual({ "bot-01": "running", "bot-02": "degraded" });
  });

  test("deliveryStats tanpa db -> tidak berpengaruh, bus tetap 'stub'", () => {
    const r = doctorReport({ deliveryStats: { delivered: 5, failed: 1 } });
    expect(r.components.bus).toBe("stub");
  });

  test("deliveryStats BERSAMA db -> digabung ke dalam komponen bus sbg field delivery", () => {
    const db = openDb(":memory:");
    const r = doctorReport({ db, deliveryStats: { delivered: 5, failed: 1 } });
    const stats = JSON.parse(r.components.bus);
    expect(stats.delivery).toEqual({ delivered: 5, failed: 1 });
    db.close();
  });

  test("tanpa deps sama sekali, adapters tetap 'stub' (backward-compat)", () => {
    const r = doctorReport();
    expect(r.components.adapters).toBe("stub");
  });
});

describe("doctorReport (Task S1 — supervisorStatuses wiring)", () => {
  test("supervisorStatuses -> komponen supervisors berisi {botId: SupervisorStatus}, bukan 'stub'", () => {
    const r = doctorReport({
      supervisorStatuses: {
        "bot-01": { holder: "running", queue: 2, awaiting_barrier: false, last_ack_s: 3, restarts: 0, barrier_alarm: false },
      },
    });
    expect(JSON.parse(r.components.supervisors)).toEqual({
      "bot-01": { holder: "running", queue: 2, awaiting_barrier: false, last_ack_s: 3, restarts: 0, barrier_alarm: false },
    });
  });

  test("tanpa deps sama sekali, supervisors tetap 'stub' (backward-compat)", () => {
    const r = doctorReport();
    expect(r.components.supervisors).toBe("stub");
  });
});
