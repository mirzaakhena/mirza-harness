import { describe, expect, test } from "bun:test";
import { Envelope } from "../src/bus";

const base = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  ts: 1234567890,
  from: "bot-01",
  to: "bot-02",
  kind: "prompt" as const,
  payload: { hello: "world" },
  hop: 0,
};

describe("Envelope schema", () => {
  test("valid envelope tanpa reply_to lolos parse", () => {
    const parsed = Envelope.parse(base);
    expect(parsed.id).toBe(base.id);
    expect(parsed.reply_to).toBeUndefined();
  });

  test("valid envelope dengan reply_to lolos parse", () => {
    const parsed = Envelope.parse({ ...base, reply_to: "some-id" });
    expect(parsed.reply_to).toBe("some-id");
  });

  test("id bukan uuid ditolak", () => {
    expect(Envelope.safeParse({ ...base, id: "not-a-uuid" }).success).toBe(false);
  });

  test("kind di luar enum ditolak", () => {
    expect(Envelope.safeParse({ ...base, kind: "bogus" }).success).toBe(false);
  });

  for (const k of ["prompt", "channel-inbound", "outbound-send"] as const) {
    test(`kind '${k}' diterima`, () => {
      expect(Envelope.safeParse({ ...base, kind: k }).success).toBe(true);
    });
  }

  test("hop negatif ditolak", () => {
    expect(Envelope.safeParse({ ...base, hop: -1 }).success).toBe(false);
  });

  test("hop non-integer ditolak", () => {
    expect(Envelope.safeParse({ ...base, hop: 1.5 }).success).toBe(false);
  });

  test("hop > 5 ditolak", () => {
    expect(Envelope.safeParse({ ...base, hop: 6 }).success).toBe(false);
  });

  test("hop 5 diterima (batas atas)", () => {
    expect(Envelope.safeParse({ ...base, hop: 5 }).success).toBe(true);
  });

  test("hop 0 diterima (batas bawah)", () => {
    expect(Envelope.safeParse({ ...base, hop: 0 }).success).toBe(true);
  });

  test("extra key ditolak (.strict())", () => {
    expect(Envelope.safeParse({ ...base, extra: "nope" }).success).toBe(false);
  });

  test("field wajib hilang ditolak", () => {
    const { from: _from, ...rest } = base;
    expect(Envelope.safeParse(rest).success).toBe(false);
  });

  test("payload menerima unknown apapun (string, angka, null)", () => {
    expect(Envelope.safeParse({ ...base, payload: "string payload" }).success).toBe(true);
    expect(Envelope.safeParse({ ...base, payload: 42 }).success).toBe(true);
    expect(Envelope.safeParse({ ...base, payload: null }).success).toBe(true);
  });
});
