import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, runRetention } from "../src/state/db";

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `mirza-hostd-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

describe("openDb — pragma", () => {
  test("journal_mode=WAL untuk file db", () => {
    const file = tmpDbPath();
    try {
      const db = openDb(file);
      const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
      db.close();
    } finally {
      for (const ext of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(file + ext); } catch { /* noop */ }
      }
    }
  });

  test("journal_mode menerima 'memory' untuk :memory:", () => {
    const db = openDb(":memory:");
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("memory");
    db.close();
  });

  test("foreign_keys ON", () => {
    const db = openDb(":memory:");
    const row = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
    db.close();
  });

  test("busy_timeout=5000", () => {
    const db = openDb(":memory:");
    const row = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(row.timeout).toBe(5000);
    db.close();
  });
});

describe("openDb — foreign key enforcement", () => {
  test("insert sessions dgn bot_id tak dikenal -> throw", () => {
    const db = openDb(":memory:");
    expect(() => {
      db.run("INSERT INTO sessions (id, bot_id, started_at) VALUES ('s1', 'bot-tak-dikenal', 0)");
    }).toThrow();
    db.close();
  });

  test("insert sessions dgn bot_id dikenal -> sukses", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO bots (id, workspace) VALUES ('bot-03', '/ws/bot-03')");
    expect(() => {
      db.run("INSERT INTO sessions (id, bot_id, started_at) VALUES ('s1', 'bot-03', 0)");
    }).not.toThrow();
    db.close();
  });
});

describe("skema messages — revisi fase 1", () => {
  test("kolom user_id, user_name, attachments, metadata tersedia", () => {
    const db = openDb(":memory:");
    db.run(
      `INSERT INTO messages (bot_id, channel, chat_id, direction, source, ts, body, user_id, user_name, attachments, metadata)
       VALUES ('bot-03','telegram','1','in','user',0,'halo','u1','Budi','["a.png"]','{"k":1}')`
    );
    const row = db.query("SELECT user_id, user_name, attachments, metadata FROM messages WHERE id = 1").get() as Record<string, string>;
    expect(row.user_id).toBe("u1");
    expect(row.user_name).toBe("Budi");
    expect(row.attachments).toBe('["a.png"]');
    expect(row.metadata).toBe('{"k":1}');
    db.close();
  });

  test("kolom meta lama sudah tidak ada (rename ke metadata)", () => {
    const db = openDb(":memory:");
    const cols = (db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain("metadata");
    expect(cols).not.toContain("meta");
    db.close();
  });
});

describe("FTS5 sinkron via trigger", () => {
  test("insert messages otomatis muncul di messages_fts", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',0,'halo dunia')");
    const hit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'halo'").all();
    expect(hit.length).toBe(1);
    db.close();
  });

  test("delete messages menghapus entri messages_fts", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',0,'halo dunia')");
    db.run("DELETE FROM messages WHERE id = 1");
    const hit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'halo'").all();
    expect(hit.length).toBe(0);
  });

  test("update messages memperbarui entri messages_fts", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',0,'lama sekali')");
    db.run("UPDATE messages SET body = 'baru sekali' WHERE id = 1");
    const oldHit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'lama'").all();
    const newHit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'baru'").all();
    expect(oldHit.length).toBe(0);
    expect(newHit.length).toBe(1);
  });
});

describe("runRetention", () => {
  const DAY = 86400;

  test("default: hapus messages > 90 hari, sisakan yang lebih baru", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',?,'lama')", [now - 100 * DAY]);
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',?,'baru')", [now - 10 * DAY]);
    runRetention(db);
    const rows = db.query("SELECT body FROM messages").all() as { body: string }[];
    expect(rows.map(r => r.body)).toEqual(["baru"]);
    db.close();
  });

  test("default: hapus bus_dead > 30 hari, sisakan yang lebih baru", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    db.run("INSERT INTO bus_dead (id, ts, envelope, reason, dead_at) VALUES ('d1', ?, '{}', 'timeout', ?)", [now - 40 * DAY, now - 40 * DAY]);
    db.run("INSERT INTO bus_dead (id, ts, envelope, reason, dead_at) VALUES ('d2', ?, '{}', 'timeout', ?)", [now - 5 * DAY, now - 5 * DAY]);
    runRetention(db);
    const rows = db.query("SELECT id FROM bus_dead").all() as { id: string }[];
    expect(rows.map(r => r.id)).toEqual(["d2"]);
    db.close();
  });

  test("kebijakan kustom dari tabel kv override default", () => {
    const db = openDb(":memory:");
    const now = Math.floor(Date.now() / 1000);
    db.run("INSERT INTO kv (key, value) VALUES ('retention.messages_days', '10')");
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',?,'umur20')", [now - 20 * DAY]);
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',?,'umur5')", [now - 5 * DAY]);
    runRetention(db);
    const rows = db.query("SELECT body FROM messages").all() as { body: string }[];
    expect(rows.map(r => r.body)).toEqual(["umur5"]);
    db.close();
  });
});
