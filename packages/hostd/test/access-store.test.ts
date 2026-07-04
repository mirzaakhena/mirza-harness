import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/state/db";
import {
  AccessSchema,
  PENDING_CAP,
  addPending,
  approvePairing,
  defaultAccess,
  getAccess,
  importLegacyAccessJson,
  setAccess,
  type Access,
} from "../src/state/access-store";

function tmpJsonPath(name: string): string {
  return path.join(
    os.tmpdir(),
    `mirza-hostd-access-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}.json`,
  );
}

describe("defaultAccess / schema default", () => {
  test("default persis {dmPolicy:'pairing', allowFrom:[], groups:{}, pending:{}}", () => {
    expect(defaultAccess()).toEqual({
      dmPolicy: "pairing",
      allowFrom: [],
      groups: {},
      pending: {},
    });
  });

  test("AccessSchema.parse({}) menghasilkan default yang sama", () => {
    expect(AccessSchema.parse({})).toEqual(defaultAccess());
  });

  test("AccessSchema .strict() menolak field tak dikenal", () => {
    expect(() => AccessSchema.parse({ dmPolicy: "pairing", allowFrom: [], groups: {}, pending: {}, extra: 1 })).toThrow();
  });

  test("AccessSchema menolak dmPolicy invalid", () => {
    expect(() => AccessSchema.parse({ dmPolicy: "bukan-mode" })).toThrow();
  });
});

describe("getAccess", () => {
  test("row tak ada -> default access", () => {
    const db = openDb(":memory:");
    expect(getAccess(db, "bot-03")).toEqual(defaultAccess());
    db.close();
  });

  test("channel default 'telegram', tak bentrok dgn channel lain", () => {
    const db = openDb(":memory:");
    setAccess(db, "bot-03", { ...defaultAccess(), allowFrom: ["u1"] }, "telegram");
    expect(getAccess(db, "bot-03", "discord")).toEqual(defaultAccess());
    expect(getAccess(db, "bot-03")).toEqual({ ...defaultAccess(), allowFrom: ["u1"] });
    db.close();
  });

  test("botId berbeda terisolasi", () => {
    const db = openDb(":memory:");
    setAccess(db, "bot-01", { ...defaultAccess(), allowFrom: ["u1"] });
    expect(getAccess(db, "bot-02")).toEqual(defaultAccess());
    db.close();
  });
});

describe("setAccess", () => {
  test("persist lalu getAccess mengembalikan data yang sama", () => {
    const db = openDb(":memory:");
    const access: Access = {
      dmPolicy: "allowlist",
      allowFrom: ["u1", "u2"],
      groups: { g1: { requireMention: true, allowFrom: ["u3"] } },
      pending: {},
      mentionPatterns: ["@mybot"],
      ackReaction: "👍",
      replyToMode: "first",
      textChunkLimit: 3000,
      chunkMode: "newline",
    };
    setAccess(db, "bot-03", access);
    expect(getAccess(db, "bot-03")).toEqual(access);
    db.close();
  });

  test("upsert menimpa nilai lama (bukan menambah baris baru)", () => {
    const db = openDb(":memory:");
    setAccess(db, "bot-03", { ...defaultAccess(), dmPolicy: "allowlist" });
    setAccess(db, "bot-03", { ...defaultAccess(), dmPolicy: "disabled" });
    const rows = db.query("SELECT COUNT(*) as n FROM channel_access WHERE bot_id = 'bot-03'").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getAccess(db, "bot-03").dmPolicy).toBe("disabled");
    db.close();
  });

  test("input invalid (zod) -> throw, tidak mengubah state", () => {
    const db = openDb(":memory:");
    expect(() =>
      setAccess(db, "bot-03", { dmPolicy: "invalid-mode" } as unknown as Access),
    ).toThrow();
    expect(getAccess(db, "bot-03")).toEqual(defaultAccess());
    db.close();
  });
});

describe("approvePairing", () => {
  test("pending -> allowFrom, entri pending terhapus", () => {
    const db = openDb(":memory:");
    addPending(db, "bot-03", "u1", "abc123");
    const result = approvePairing(db, "bot-03", "u1");
    expect(result.allowFrom).toEqual(["u1"]);
    expect(result.pending).toEqual({});
    db.close();
  });

  test("idempotent: approve dua kali tidak error & tidak duplikat", () => {
    const db = openDb(":memory:");
    addPending(db, "bot-03", "u1", "abc123");
    approvePairing(db, "bot-03", "u1");
    expect(() => approvePairing(db, "bot-03", "u1")).not.toThrow();
    const final = getAccess(db, "bot-03");
    expect(final.allowFrom).toEqual(["u1"]);
    expect(final.pending).toEqual({});
    db.close();
  });

  test("approve userId tanpa entri pending -> tetap masuk allowFrom, tidak error", () => {
    const db = openDb(":memory:");
    const result = approvePairing(db, "bot-03", "u9");
    expect(result.allowFrom).toEqual(["u9"]);
    db.close();
  });

  test("hanya menghapus entri pending milik userId yang cocok", () => {
    const db = openDb(":memory:");
    addPending(db, "bot-03", "u1", "code1");
    addPending(db, "bot-03", "u2", "code2");
    const result = approvePairing(db, "bot-03", "u1");
    expect(result.allowFrom).toEqual(["u1"]);
    expect(Object.keys(result.pending)).toEqual(["code2"]);
    db.close();
  });
});

describe("addPending", () => {
  test("menambah entri pending baru", () => {
    const db = openDb(":memory:");
    const result = addPending(db, "bot-03", "u1", "code1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.access.pending.code1.senderId).toBe("u1");
      expect(result.access.pending.code1.chatId).toBe("u1");
      expect(result.access.pending.code1.replies).toBe(1);
    }
    db.close();
  });

  test(`cap pending di ${PENDING_CAP} (ikut kode acuan)`, () => {
    const db = openDb(":memory:");
    for (let i = 0; i < PENDING_CAP; i++) {
      const r = addPending(db, "bot-03", `u${i}`, `code${i}`);
      expect(r.ok).toBe(true);
    }
    const over = addPending(db, "bot-03", "u-over", "code-over");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain(String(PENDING_CAP));
    expect(Object.keys(getAccess(db, "bot-03").pending).length).toBe(PENDING_CAP);
    db.close();
  });

  test("menulis ulang code yang sama tidak dihitung ganda thd cap", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < PENDING_CAP; i++) {
      addPending(db, "bot-03", `u${i}`, `code${i}`);
    }
    const rewrite = addPending(db, "bot-03", "u0-baru", "code0");
    expect(rewrite.ok).toBe(true);
    if (rewrite.ok) expect(rewrite.access.pending.code0.senderId).toBe("u0-baru");
    db.close();
  });
});

describe("importLegacyAccessJson", () => {
  test("file JSON valid & lengkap -> setAccess sukses", () => {
    const db = openDb(":memory:");
    const file = tmpJsonPath("valid-full");
    const legacy: Access = {
      dmPolicy: "allowlist",
      allowFrom: ["u1"],
      groups: {},
      pending: {},
      mentionPatterns: ["@bot"],
    };
    fs.writeFileSync(file, JSON.stringify(legacy));
    try {
      const result = importLegacyAccessJson(db, "bot-03", file);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.access).toEqual(legacy);
      expect(getAccess(db, "bot-03")).toEqual(legacy);
    } finally {
      fs.unlinkSync(file);
    }
    db.close();
  });

  test("file JSON valid tapi parsial (field lama hilang) -> default terisi", () => {
    const db = openDb(":memory:");
    const file = tmpJsonPath("valid-partial");
    fs.writeFileSync(file, JSON.stringify({ allowFrom: ["u5"] }));
    try {
      const result = importLegacyAccessJson(db, "bot-03", file);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.access.dmPolicy).toBe("pairing");
        expect(result.access.allowFrom).toEqual(["u5"]);
        expect(result.access.groups).toEqual({});
        expect(result.access.pending).toEqual({});
      }
    } finally {
      fs.unlinkSync(file);
    }
    db.close();
  });

  test("file korup (JSON rusak, real file) -> {ok:false, reason}, tidak throw, file tak disentuh", () => {
    const db = openDb(":memory:");
    const file = tmpJsonPath("corrupt");
    fs.writeFileSync(file, '{"dmPolicy": "pairing", "allowFrom": [oops corrupt');
    try {
      expect(() => importLegacyAccessJson(db, "bot-03", file)).not.toThrow();
      const result = importLegacyAccessJson(db, "bot-03", file);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBeTruthy();
      // caller yang memutuskan rename .corrupt-<ts> — store tidak menyentuh fs selain baca
      expect(fs.existsSync(file)).toBe(true);
      expect(getAccess(db, "bot-03")).toEqual(defaultAccess());
    } finally {
      fs.unlinkSync(file);
    }
    db.close();
  });

  test("JSON valid tapi gagal skema (tipe salah) -> {ok:false, reason}, tidak throw", () => {
    const db = openDb(":memory:");
    const file = tmpJsonPath("schema-invalid");
    fs.writeFileSync(file, JSON.stringify({ dmPolicy: 123, allowFrom: "bukan-array" }));
    try {
      const result = importLegacyAccessJson(db, "bot-03", file);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBeTruthy();
    } finally {
      fs.unlinkSync(file);
    }
    db.close();
  });

  test("file tak ada -> {ok:false, reason}, tidak throw", () => {
    const db = openDb(":memory:");
    const missing = tmpJsonPath("missing-never-written");
    expect(() => importLegacyAccessJson(db, "bot-03", missing)).not.toThrow();
    const result = importLegacyAccessJson(db, "bot-03", missing);
    expect(result.ok).toBe(false);
    db.close();
  });
});
