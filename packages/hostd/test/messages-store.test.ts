import { describe, expect, spyOn, test } from "bun:test";
import { openDb } from "../src/state/db";
import { createMessagesStore } from "../src/state/messages-store";

function freshDb() {
  const db = openDb(":memory:");
  db.run("INSERT INTO bots (id, workspace) VALUES ('bot-03', '/ws/bot-03')");
  return db;
}

describe("messages-store: logInbound text-only", () => {
  test("persists inbound with required fields (direction=in, source=user)", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000000000,
      chat_id: "12345",
      message_id: "99",
      user_id: "777",
      user_name: "mirza",
      body: "halo",
    });

    const rows = db.query("SELECT * FROM messages").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      bot_id: "bot-03",
      channel: "telegram",
      ts: 1700000000000,
      chat_id: "12345",
      message_id: "99",
      direction: "in",
      source: "user",
      user_id: "777",
      user_name: "mirza",
      body: "halo",
      attachments: null,
      metadata: null,
    });
    db.close();
  });

  test("body omitted -> stored as '' (schema has body NOT NULL, never null)", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000000010, chat_id: "12345" });

    const row = db.query("SELECT body FROM messages WHERE ts = 1700000000010").get() as any;
    expect(row.body).toBe("");
    db.close();
  });
});

describe("messages-store: logInbound full payload", () => {
  test("persists attachments JSON and reply_to folded into metadata", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000000000,
      chat_id: "12345",
      message_id: "100",
      user_id: "777",
      user_name: "mirza",
      body: "look at this",
      attachments: [{ type: "photo", path: "/inbox/abc.jpg", file_id: "AgAC" }],
      reply_to: "88",
      metadata: { format: "plain" },
    });

    const row = db.query("SELECT * FROM messages WHERE message_id = ?").get("100") as any;
    expect(JSON.parse(row.attachments)).toEqual([
      { type: "photo", path: "/inbox/abc.jpg", file_id: "AgAC" },
    ]);
    expect(JSON.parse(row.metadata)).toEqual({ format: "plain", reply_to: "88" });
    db.close();
  });

  test("attachments empty array stored as JSON not NULL", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    store.logInbound({ ts: 1700000000001, chat_id: "12345", attachments: [] });
    const row = db.query("SELECT attachments FROM messages WHERE ts = 1700000000001").get() as any;
    expect(row.attachments).toBe("[]");
    db.close();
  });
});

describe("messages-store: logOutbound", () => {
  test("persists outbound with source=assistant, direction=out", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logOutbound({
      ts: 1700000001000,
      chat_id: "12345",
      message_id: "101",
      source: "assistant",
      body: "oke siap",
    });

    const row = db.query("SELECT * FROM messages WHERE message_id = ?").get("101") as any;
    expect(row).toMatchObject({
      direction: "out",
      source: "assistant",
      chat_id: "12345",
      body: "oke siap",
      user_id: null,
      user_name: null,
    });
    db.close();
  });
});

describe("messages-store: logOutbound system source (LOSS-4 fix)", () => {
  // LOSS-4: there is no `append` method. Anything that needs to log a
  // session-change / system event (what `append` used to do upstream) goes
  // through logOutbound({ source: 'system', ... }) instead.
  test("interface has no append method", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    expect((store as any).append).toBeUndefined();
    db.close();
  });

  test("session-change event logged via logOutbound(source='system') round-trips", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logOutbound({
      ts: 1700000002000,
      chat_id: "12345",
      message_id: "102",
      source: "system",
      body: "session resumed",
      metadata: { event: "session_resume", triggered_by: "cron:hydration" },
    });

    const row = db.query("SELECT direction, source, body, metadata FROM messages WHERE message_id = ?").get("102") as any;
    expect(row.direction).toBe("out");
    expect(row.source).toBe("system");
    expect(row.body).toBe("session resumed");
    expect(JSON.parse(row.metadata)).toEqual({ event: "session_resume", triggered_by: "cron:hydration" });

    // And it's retrievable through the normal getMessage path, same as any
    // other message — no special-cased "event log" API needed.
    const fetched = store.getMessage("12345", "102");
    expect(fetched).toMatchObject({ source: "system", direction: "out", body: "session resumed" });
    db.close();
  });
});

describe("messages-store: failure isolation", () => {
  test("write failure -> stderr warning, no throw, normal flow continues", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    db.exec("DROP TABLE messages");

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => store.logInbound({ ts: 1, chat_id: "x", body: "hi" })).not.toThrow();
    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((w) => w.includes("messages-store") && w.includes("write failed"))).toBe(true);
    stderrSpy.mockRestore();
  });

  test("read failure -> stderr warning, getMessage returns null, no throw", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    db.exec("DROP TABLE messages");

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => store.getMessage("x", "1")).not.toThrow();
    expect(store.getMessage("x", "1")).toBeNull();
    const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(writes.some((w) => w.includes("messages-store") && w.includes("read failed"))).toBe(true);
    stderrSpy.mockRestore();
  });
});

describe("messages-store: album logging shape", () => {
  test("logInbound with multi-attachment + media_group_id metadata roundtrips", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000000000,
      chat_id: "CHAT1",
      message_id: "101",
      user_id: "U1",
      user_name: "alice",
      body: "check this",
      attachments: [
        { type: "photo", path: "/inbox/a.jpg" },
        { type: "photo", path: "/inbox/b.jpg" },
        { type: "document", file_id: "DOC1", name: "foo.pdf", mime: "application/pdf", size: 12345 },
      ],
      metadata: { media_group_id: "MG_ABC", message_ids: ["101", "102", "103"] },
    });

    const rows = db
      .query("SELECT attachments, metadata FROM messages WHERE chat_id = ?")
      .all("CHAT1") as Array<{ attachments: string; metadata: string }>;
    expect(rows).toHaveLength(1);

    const att = JSON.parse(rows[0].attachments);
    expect(att).toHaveLength(3);
    expect(att[2]).toEqual({ type: "document", file_id: "DOC1", name: "foo.pdf", mime: "application/pdf", size: 12345 });

    const meta = JSON.parse(rows[0].metadata);
    expect(meta.media_group_id).toBe("MG_ABC");
    expect(meta.message_ids).toEqual(["101", "102", "103"]);
    db.close();
  });

  test("logInbound with no attachments stores null (no rows lost)", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000000001, chat_id: "CHAT2", message_id: "201", user_id: "U2", user_name: "bob", body: "no attachments" });

    const rows = db.query("SELECT attachments FROM messages WHERE chat_id = ?").all("CHAT2") as Array<{ attachments: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].attachments).toBeNull();
    db.close();
  });
});

describe("messages-store: logInbound quote_text + reply_to metadata merge", () => {
  test("quote_text + quote_is_manual + reply_to round-trip through metadata column", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000005000,
      chat_id: "CHAT_Q",
      message_id: "301",
      user_id: "U_Q",
      user_name: "mirza",
      body: "This..",
      reply_to: "300",
      quote_text: "the part the user selected",
      quote_is_manual: true,
    });

    const row = db.query("SELECT metadata FROM messages WHERE message_id = ?").get("301") as any;
    expect(JSON.parse(row.metadata)).toEqual({
      reply_to: "300",
      quote_text: "the part the user selected",
      quote_is_manual: true,
    });
    db.close();
  });

  test("quote fields merge with caller-supplied metadata (album case)", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000005001,
      chat_id: "CHAT_Q",
      message_id: "302",
      body: "reply to album",
      quote_text: "original album caption",
      quote_is_manual: false,
      metadata: { media_group_id: "MG_X", message_ids: ["302", "303"] },
    });

    const row = db.query("SELECT metadata FROM messages WHERE message_id = ?").get("302") as any;
    expect(JSON.parse(row.metadata)).toEqual({
      media_group_id: "MG_X",
      message_ids: ["302", "303"],
      quote_text: "original album caption",
      quote_is_manual: false,
    });
    db.close();
  });

  test("no reply_to / quote_text supplied -> no keys added, metadata stays null", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000005002, chat_id: "CHAT_Q", message_id: "303", body: "plain reply, no quote captured" });

    const row = db.query("SELECT metadata FROM messages WHERE message_id = ?").get("303") as any;
    expect(row.metadata).toBeNull();
    db.close();
  });
});

describe("messages-store: getMessage", () => {
  test("direct hit returns user message with parsed attachments + metadata", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000010000,
      chat_id: "CHAT_G",
      message_id: "500",
      user_id: "U500",
      user_name: "mirza",
      body: "message with photo",
      attachments: [{ type: "photo", path: "/inbox/x.jpg" }],
      reply_to: "499",
      quote_text: "previous one",
      quote_is_manual: true,
    });

    const row = store.getMessage("CHAT_G", "500");
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      chat_id: "CHAT_G",
      message_id: "500",
      direction: "in",
      source: "user",
      ts: 1700000010000,
      body: "message with photo",
      user_id: "U500",
      user_name: "mirza",
    });
    expect(row!.attachments).toEqual([{ type: "photo", path: "/inbox/x.jpg" }]);
    expect(row!.metadata).toEqual({ reply_to: "499", quote_text: "previous one", quote_is_manual: true });
    db.close();
  });

  test("direct hit returns assistant message", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logOutbound({ ts: 1700000011000, chat_id: "CHAT_G", message_id: "501", source: "assistant", body: "reply from the bot" });

    const row = store.getMessage("CHAT_G", "501");
    expect(row).toMatchObject({ message_id: "501", direction: "out", source: "assistant", body: "reply from the bot", user_id: null, user_name: null });
    db.close();
  });

  test("album reply to first item -> direct hit succeeds", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000012000,
      chat_id: "CHAT_G",
      message_id: "600",
      body: "caption album",
      attachments: [{ type: "photo", path: "/inbox/a.jpg" }, { type: "photo", path: "/inbox/b.jpg" }],
      metadata: { media_group_id: "MG_600", message_ids: ["600", "601", "602"] },
    });

    const row = store.getMessage("CHAT_G", "600");
    expect(row).not.toBeNull();
    expect(row!.attachments).toHaveLength(2);
    expect((row!.metadata as any).message_ids).toEqual(["600", "601", "602"]);
    db.close();
  });

  test("album reply to non-first item -> fallback finds the same row", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({
      ts: 1700000013000,
      chat_id: "CHAT_G",
      message_id: "700",
      body: "caption album",
      attachments: [{ type: "photo", path: "/inbox/c.jpg" }, { type: "photo", path: "/inbox/d.jpg" }, { type: "photo", path: "/inbox/e.jpg" }],
      metadata: { media_group_id: "MG_700", message_ids: ["700", "701", "702"] },
    });

    const row = store.getMessage("CHAT_G", "701");
    expect(row).not.toBeNull();
    expect(row!.message_id).toBe("700");
    expect(row!.attachments).toHaveLength(3);
    expect((row!.metadata as any).message_ids).toContain("701");
    db.close();
  });

  test("not found -> returns null", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    expect(store.getMessage("CHAT_G", "9999")).toBeNull();
    db.close();
  });

  test("cross-chat isolation: same message_id in different chat -> not returned", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000014000, chat_id: "CHAT_A", message_id: "800", body: "message in chat A" });

    expect(store.getMessage("CHAT_B", "800")).toBeNull();
    db.close();
  });

  test("cross-bot/channel isolation: same chat_id + message_id under a different bot_id or channel -> not returned", () => {
    const db = freshDb();
    db.run("INSERT INTO bots (id, workspace) VALUES ('bot-04', '/ws/bot-04')");
    const storeA = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    const storeOtherBot = createMessagesStore({ db, botId: "bot-04", channel: "telegram" });
    const storeOtherChannel = createMessagesStore({ db, botId: "bot-03", channel: "discord" });

    storeA.logInbound({ ts: 1700000014500, chat_id: "SHARED", message_id: "900", body: "bot-03/telegram only" });

    expect(storeA.getMessage("SHARED", "900")).not.toBeNull();
    expect(storeOtherBot.getMessage("SHARED", "900")).toBeNull();
    expect(storeOtherChannel.getMessage("SHARED", "900")).toBeNull();
    db.close();
  });

  test("LIKE false-positive guard: substring of unrelated metadata value does not match", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000015000, chat_id: "CHAT_G", message_id: "900", body: "unrelated", metadata: { some_field: "value containing 999 substring" } });

    expect(store.getMessage("CHAT_G", "999")).toBeNull();
    db.close();
  });

  test("multi-row safety: when duplicate (chat_id, message_id) exist, returns latest by ts", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000016000, chat_id: "CHAT_G", message_id: "1000", body: "older" });
    store.logInbound({ ts: 1700000017000, chat_id: "CHAT_G", message_id: "1000", body: "newer" });

    const row = store.getMessage("CHAT_G", "1000");
    expect(row!.body).toBe("newer");
    db.close();
  });
});

describe("messages-store: searchFts (IDEA-3 foundation)", () => {
  test("finds a message by full-text match on body", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000020000, chat_id: "CHAT_S", message_id: "1", body: "tolong reset server produksi" });
    store.logOutbound({ ts: 1700000020001, chat_id: "CHAT_S", message_id: "2", source: "assistant", body: "siap, server sudah direset" });
    store.logInbound({ ts: 1700000020002, chat_id: "CHAT_S", message_id: "3", body: "makan siang dulu ya" });

    const results = store.searchFts("server");
    expect(results.map((r) => r.message_id).sort()).toEqual(["1", "2"]);
  });

  test("orders results by ts DESC", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    store.logInbound({ ts: 1700000021000, chat_id: "CHAT_S", message_id: "10", body: "cari kata kunci pertama" });
    store.logInbound({ ts: 1700000021500, chat_id: "CHAT_S", message_id: "11", body: "cari kata kunci kedua" });

    const results = store.searchFts("kunci");
    expect(results.map((r) => r.message_id)).toEqual(["11", "10"]);
  });

  test("respects the limit parameter", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });

    for (let i = 0; i < 5; i++) {
      store.logInbound({ ts: 1700000022000 + i, chat_id: "CHAT_S", message_id: String(20 + i), body: "duplikat pencarian" });
    }

    expect(store.searchFts("duplikat")).toHaveLength(5);
    expect(store.searchFts("duplikat", 2)).toHaveLength(2);
  });

  test("no match -> returns empty array", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    store.logInbound({ ts: 1700000023000, chat_id: "CHAT_S", message_id: "30", body: "sesuatu" });
    expect(store.searchFts("tidakadaginikatanya")).toEqual([]);
  });

  test("scoped to this store's bot_id/channel: hits from another bot are excluded", () => {
    const db = freshDb();
    db.run("INSERT INTO bots (id, workspace) VALUES ('bot-04', '/ws/bot-04')");
    const storeA = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    const storeB = createMessagesStore({ db, botId: "bot-04", channel: "telegram" });

    storeB.logInbound({ ts: 1700000024000, chat_id: "CHAT_S", message_id: "40", body: "rahasia bot lain" });

    expect(storeA.searchFts("rahasia")).toEqual([]);
    expect(storeB.searchFts("rahasia")).toHaveLength(1);
  });
});

describe("messages-store: SCAR-097 disabled degradation", () => {
  test("enabled:false -> every method is a silent no-op, nothing throws", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram", enabled: false });

    expect(() => store.logInbound({ ts: 1, chat_id: "x", body: "hi" })).not.toThrow();
    expect(() => store.logOutbound({ ts: 1, chat_id: "x", source: "assistant", body: "hi" })).not.toThrow();
    expect(store.getMessage("x", "1")).toBeNull();
    expect(store.searchFts("hi")).toEqual([]);

    // No rows were actually written.
    const rows = db.query("SELECT * FROM messages").all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  test("enabled defaults to true when omitted", () => {
    const db = freshDb();
    const store = createMessagesStore({ db, botId: "bot-03", channel: "telegram" });
    store.logInbound({ ts: 1700000025000, chat_id: "x", body: "hi" });
    expect(db.query("SELECT * FROM messages").all()).toHaveLength(1);
    db.close();
  });
});
