import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applySchema } from "../src/schema";

const EXPECTED_TABLES = [
  "bots", "sessions", "messages", "bus_queue", "bus_dead",
  "goals", "handoffs", "channel_access", "kv",
];

describe("skema sqlite (draft fase 0)", () => {
  test("semua tabel inti tercipta dan idempotent", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db); // idempotent — tak boleh throw
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = rows.map(r => r.name);
    for (const t of EXPECTED_TABLES) expect(names).toContain(t);
  });

  test("FTS5 messages_fts tersedia dan tersinkron otomatis via trigger", () => {
    const db = new Database(":memory:");
    applySchema(db);
    // Tidak ada insert manual ke messages_fts — trigger AFTER INSERT pada
    // `messages` yang menjaga sinkronisasi (external content table).
    db.run("INSERT INTO messages (bot_id, channel, chat_id, direction, ts, body) VALUES ('bot-03','telegram','1','in',0,'halo dunia')");
    const hit = db.query("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'halo'").all();
    expect(hit.length).toBe(1);
  });
});
