import { describe, expect, test } from "bun:test";
import { doctorReport } from "../src/doctor";

describe("doctorReport (stub fase 0)", () => {
  test("bentuk payload lengkap", () => {
    const r = doctorReport();
    expect(r.ok).toBe(true);
    expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.pid).toBe(process.pid);
    expect(r.uptime_s).toBeGreaterThanOrEqual(0);
    expect(r.db).toContain("fase 1");
    expect(Object.keys(r.components)).toEqual(["bus", "state", "adapters", "supervisors"]);
  });
});
