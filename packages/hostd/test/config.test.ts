import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostdConfigSchema, loadConfig } from "../src/config";

const VALID_TOKEN = "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // 35 char setelah ':'

function tmpConfigPath(name: string): string {
  return path.join(
    os.tmpdir(),
    `mirza-hostd-config-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}.json`,
  );
}

function writeConfig(p: string, content: string): void {
  fs.writeFileSync(p, content, "utf8");
}

describe("loadConfig — file valid", () => {
  test("membaca {bots:[{id,telegram_token,workspace}]} lewat path eksplisit", () => {
    const p = tmpConfigPath("valid");
    writeConfig(
      p,
      JSON.stringify({
        bots: [{ id: "bot-03", telegram_token: VALID_TOKEN, workspace: "C:/workspace/bot-03" }],
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg).toEqual({
      bots: [{ id: "bot-03", telegram_token: VALID_TOKEN, workspace: "C:/workspace/bot-03" }],
    });
    fs.rmSync(p);
  });

  test("mendukung beberapa bot sekaligus", () => {
    const p = tmpConfigPath("multi");
    writeConfig(
      p,
      JSON.stringify({
        bots: [
          { id: "bot-a", telegram_token: VALID_TOKEN, workspace: "C:/ws/a" },
          { id: "bot-b", telegram_token: VALID_TOKEN, workspace: "C:/ws/b" },
        ],
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.bots).toHaveLength(2);
    expect(cfg.bots.map((b) => b.id)).toEqual(["bot-a", "bot-b"]);
    fs.rmSync(p);
  });

  test("path eksplisit menang atas MIRZA_HOSTD_CONFIG", () => {
    const explicit = tmpConfigPath("explicit-wins");
    const envPath = tmpConfigPath("env-path-should-not-be-used");
    writeConfig(
      explicit,
      JSON.stringify({ bots: [{ id: "explicit", telegram_token: VALID_TOKEN, workspace: "C:/ws" }] }),
    );
    writeConfig(
      envPath,
      JSON.stringify({ bots: [{ id: "from-env", telegram_token: VALID_TOKEN, workspace: "C:/ws" }] }),
    );
    const prevEnv = process.env.MIRZA_HOSTD_CONFIG;
    process.env.MIRZA_HOSTD_CONFIG = envPath;
    try {
      const cfg = loadConfig(explicit);
      expect(cfg.bots[0]!.id).toBe("explicit");
    } finally {
      if (prevEnv === undefined) delete process.env.MIRZA_HOSTD_CONFIG;
      else process.env.MIRZA_HOSTD_CONFIG = prevEnv;
      fs.rmSync(explicit);
      fs.rmSync(envPath);
    }
  });

  test("MIRZA_HOSTD_CONFIG dipakai saat path eksplisit tak diberikan", () => {
    const envPath = tmpConfigPath("env-path");
    writeConfig(
      envPath,
      JSON.stringify({ bots: [{ id: "from-env", telegram_token: VALID_TOKEN, workspace: "C:/ws" }] }),
    );
    const prevEnv = process.env.MIRZA_HOSTD_CONFIG;
    process.env.MIRZA_HOSTD_CONFIG = envPath;
    try {
      const cfg = loadConfig();
      expect(cfg.bots[0]!.id).toBe("from-env");
    } finally {
      if (prevEnv === undefined) delete process.env.MIRZA_HOSTD_CONFIG;
      else process.env.MIRZA_HOSTD_CONFIG = prevEnv;
      fs.rmSync(envPath);
    }
  });
});

describe("loadConfig — LOSS-5: telegram_token di-trim", () => {
  test("CRLF + spasi di sekeliling token ke-trim otomatis", () => {
    const p = tmpConfigPath("crlf-token");
    writeConfig(
      p,
      JSON.stringify({
        bots: [{ id: "bot-03", telegram_token: `  ${VALID_TOKEN}\r\n`, workspace: "C:/ws" }],
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.bots[0]!.telegram_token).toBe(VALID_TOKEN);
    fs.rmSync(p);
  });

  test("BOM di awal token ke-strip otomatis", () => {
    const p = tmpConfigPath("bom-token");
    writeConfig(
      p,
      JSON.stringify({
        bots: [{ id: "bot-03", telegram_token: `﻿${VALID_TOKEN}`, workspace: "C:/ws" }],
      }),
    );
    const cfg = loadConfig(p);
    expect(cfg.bots[0]!.telegram_token).toBe(VALID_TOKEN);
    fs.rmSync(p);
  });
});

describe("loadConfig — format token salah", () => {
  test("token tanpa ':' -> error jelas menyebut format yang benar", () => {
    const p = tmpConfigPath("bad-format");
    writeConfig(
      p,
      JSON.stringify({ bots: [{ id: "bot-03", telegram_token: "bukan-token-telegram", workspace: "C:/ws" }] }),
    );
    expect(() => loadConfig(p)).toThrow(/telegram_token tidak valid/);
    try {
      loadConfig(p);
    } catch (err) {
      expect((err as Error).message).toMatch(/format yang benar/i);
      expect((err as Error).message).toMatch(/hostd\.config\.example\.json/);
    }
    fs.rmSync(p);
  });

  test("bagian setelah ':' terlalu pendek -> ditolak", () => {
    const p = tmpConfigPath("short-secret");
    writeConfig(
      p,
      JSON.stringify({ bots: [{ id: "bot-03", telegram_token: "123456789:tooShort", workspace: "C:/ws" }] }),
    );
    expect(() => loadConfig(p)).toThrow();
    fs.rmSync(p);
  });

  test("id numerik hilang -> ditolak", () => {
    const p = tmpConfigPath("no-numeric-id");
    writeConfig(
      p,
      JSON.stringify({ bots: [{ id: "bot-03", telegram_token: `abc:${"x".repeat(35)}`, workspace: "C:/ws" }] }),
    );
    expect(() => loadConfig(p)).toThrow();
    fs.rmSync(p);
  });
});

describe("loadConfig — file hilang / invalid", () => {
  test("file tak ada -> error menyebut path yang dicoba + contoh file", () => {
    const missing = tmpConfigPath("does-not-exist");
    expect(() => loadConfig(missing)).toThrow();
    try {
      loadConfig(missing);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(missing);
      expect(msg).toMatch(/hostd\.config\.example\.json/);
      expect(msg).toMatch(/MIRZA_HOSTD_CONFIG/);
    }
  });

  test("JSON rusak -> error jelas (bukan crash JSON.parse mentah)", () => {
    const p = tmpConfigPath("broken-json");
    writeConfig(p, "{ bots: [ ini bukan json valid");
    expect(() => loadConfig(p)).toThrow(/bukan JSON valid/);
    fs.rmSync(p);
  });

  test("field tak dikenal -> ditolak (strict)", () => {
    const p = tmpConfigPath("extra-field");
    writeConfig(
      p,
      JSON.stringify({
        bots: [{ id: "bot-03", telegram_token: VALID_TOKEN, workspace: "C:/ws" }],
        extra: true,
      }),
    );
    expect(() => loadConfig(p)).toThrow();
    fs.rmSync(p);
  });

  test("bots bukan array -> ditolak", () => {
    const p = tmpConfigPath("bots-not-array");
    writeConfig(p, JSON.stringify({ bots: "nope" }));
    expect(() => loadConfig(p)).toThrow();
    fs.rmSync(p);
  });
});

describe("HostdConfigSchema", () => {
  test("diekspor dan bisa dipakai langsung (safeParse)", () => {
    const result = HostdConfigSchema.safeParse({
      bots: [{ id: "x", telegram_token: VALID_TOKEN, workspace: "C:/ws" }],
    });
    expect(result.success).toBe(true);
  });
});
