import { describe, expect, test } from "bun:test";
import { openDb } from "../src/state/db";
import { addPending, getAccess } from "../src/state/access-store";
import { runAccessCommand } from "../src/cli";

describe("runAccessCommand — access approve", () => {
  test("memindahkan pending -> allowFrom, hapus entri pending", () => {
    const db = openDb(":memory:");
    addPending(db, "bot-07", "u1", "code1");
    const result = runAccessCommand(db, ["approve", "bot-07", "u1"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("u1");
    const access = getAccess(db, "bot-07");
    expect(access.allowFrom).toEqual(["u1"]);
    expect(access.pending).toEqual({});
    db.close();
  });

  test("bot_id hilang -> usage error exit 2", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["approve"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("pakai");
    db.close();
  });

  test("user_id hilang -> usage error exit 2", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["approve", "bot-07"]);
    expect(result.exitCode).toBe(2);
    db.close();
  });
});

describe("runAccessCommand — access allow", () => {
  test("menambah userId langsung ke allowFrom (tanpa pending)", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["allow", "bot-07", "u2"]);
    expect(result.exitCode).toBe(0);
    expect(getAccess(db, "bot-07").allowFrom).toEqual(["u2"]);
    db.close();
  });

  test("idempotent: allow dua kali tidak duplikat", () => {
    const db = openDb(":memory:");
    runAccessCommand(db, ["allow", "bot-07", "u2"]);
    runAccessCommand(db, ["allow", "bot-07", "u2"]);
    expect(getAccess(db, "bot-07").allowFrom).toEqual(["u2"]);
    db.close();
  });

  test("bot_id/user_id hilang -> usage error exit 2", () => {
    const db = openDb(":memory:");
    expect(runAccessCommand(db, ["allow"]).exitCode).toBe(2);
    expect(runAccessCommand(db, ["allow", "bot-07"]).exitCode).toBe(2);
    db.close();
  });
});

describe("runAccessCommand — access show", () => {
  test("mencetak access JSON (default bila belum ada baris)", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["show", "bot-07"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual(getAccess(db, "bot-07"));
    db.close();
  });

  test("mencetak access setelah approve", () => {
    const db = openDb(":memory:");
    addPending(db, "bot-07", "u1", "code1");
    runAccessCommand(db, ["approve", "bot-07", "u1"]);
    const result = runAccessCommand(db, ["show", "bot-07"]);
    const parsed = JSON.parse(result.output);
    expect(parsed.allowFrom).toEqual(["u1"]);
    db.close();
  });

  test("bot_id hilang -> usage error exit 2", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["show"]);
    expect(result.exitCode).toBe(2);
    db.close();
  });
});

describe("runAccessCommand — subcommand tak dikenal", () => {
  test("exit 2 + pesan usage", () => {
    const db = openDb(":memory:");
    const result = runAccessCommand(db, ["bukan-subcommand"]);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain("pakai");
    db.close();
  });
});
