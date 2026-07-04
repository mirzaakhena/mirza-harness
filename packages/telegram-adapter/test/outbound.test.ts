// New test suite for outbound.ts — Task C5, Fase 1. Ports the behavior of
// `plugins/telegram/server.ts:695-901` (mirza-marketplace, reply/react/
// download_attachment/get_message_by_id handlers) into a pure factory test.
// No real network, no real Telegram bot — `OutboundApi` is faked entirely in
// memory; the filesystem is exercised for real (anti-exfil + download write)
// against a unique temp dir, same convention as
// packages/hostd/test/access-store.test.ts.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InputFile } from "grammy";
import { applySchema, defaultAccess, type Access } from "@mirza-harness/shared";
import {
  assertSendable,
  createOutboundSender,
  REACTION_EMOJI_WHITELIST,
  type OutboundApi,
  type OutboundStore,
} from "../src/outbound";

function tmpDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mirza-outbound-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), allowFrom: ["u1"], ...overrides };
}

// ---------------------------------------------------------------------------
// Fakes.
// ---------------------------------------------------------------------------

interface SendMessageCall {
  chat_id: string;
  text: string;
  other?: { parse_mode?: "MarkdownV2"; reply_markup?: unknown; reply_parameters?: { message_id: number } };
}

class FakeApi implements OutboundApi {
  sendMessageCalls: SendMessageCall[] = [];
  sendPhotoCalls: { chat_id: string; input: InputFile; other?: unknown }[] = [];
  sendDocumentCalls: { chat_id: string; input: InputFile; other?: unknown }[] = [];
  reactionCalls: { chat_id: string; message_id: number; reaction: unknown }[] = [];
  getFileResult: { file_path?: string; file_unique_id?: string } = {};
  /** 0-based indices into sendMessageCalls that should throw a parse-entities error, once. */
  failParseAt = new Set<number>();
  private nextId = 1;

  async sendMessage(chat_id: string, text: string, other?: SendMessageCall["other"]) {
    const idx = this.sendMessageCalls.length;
    this.sendMessageCalls.push({ chat_id, text, other });
    if (this.failParseAt.has(idx)) {
      this.failParseAt.delete(idx);
      throw { description: "Bad Request: can't parse entities: some converter edge case" };
    }
    return { message_id: this.nextId++ };
  }

  async sendPhoto(chat_id: string, input: InputFile, other?: unknown) {
    this.sendPhotoCalls.push({ chat_id, input, other });
    return { message_id: this.nextId++ };
  }

  async sendDocument(chat_id: string, input: InputFile, other?: unknown) {
    this.sendDocumentCalls.push({ chat_id, input, other });
    return { message_id: this.nextId++ };
  }

  async setMessageReaction(chat_id: string, message_id: number, reaction: unknown) {
    this.reactionCalls.push({ chat_id, message_id, reaction });
    return true;
  }

  async getFile(_file_id: string) {
    return this.getFileResult;
  }
}

class FakeStore implements OutboundStore {
  logs: Array<{
    ts: number;
    chat_id: string;
    message_id?: string;
    source: "assistant" | "system";
    body?: string;
    attachments?: unknown[];
    reply_to?: string;
    metadata?: Record<string, unknown>;
  }> = [];

  logOutbound(input: FakeStore["logs"][number]): void {
    this.logs.push(input);
  }

  getMessage(): unknown | null {
    return null;
  }
}

/** A real store backed by a real in-memory SQLite db (packages/shared schema, A1). */
function realStore(botId: string, channel: string): OutboundStore {
  const db = new Database(":memory:");
  applySchema(db);
  return {
    logOutbound(input) {
      const meta: Record<string, unknown> = { ...(input.metadata ?? {}) };
      if (input.reply_to != null) meta.reply_to = input.reply_to;
      const metaJson = Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
      db.prepare(
        `INSERT INTO messages (bot_id, channel, chat_id, message_id, direction, source, ts, body, attachments, metadata)
         VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?)`,
      ).run(
        botId,
        channel,
        input.chat_id,
        input.message_id ?? null,
        input.source,
        input.ts,
        input.body ?? "",
        input.attachments ? JSON.stringify(input.attachments) : null,
        metaJson,
      );
    },
    getMessage(chat_id: string, message_id: string) {
      const row = db
        .prepare(
          `SELECT chat_id, message_id, direction, source, ts, body, user_id, user_name, attachments, metadata
             FROM messages
            WHERE bot_id = ? AND channel = ? AND chat_id = ? AND message_id = ?
            ORDER BY ts DESC LIMIT 1`,
        )
        .get(botId, channel, chat_id, message_id) as
        | {
            chat_id: string;
            message_id: string | null;
            direction: string;
            source: string | null;
            ts: number;
            body: string;
            user_id: string | null;
            user_name: string | null;
            attachments: string | null;
            metadata: string | null;
          }
        | null;
      if (!row) return null;
      return {
        ...row,
        attachments: row.attachments ? JSON.parse(row.attachments) : null,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
      };
    },
  };
}

function makeSender<S extends OutboundStore = FakeStore>(opts: {
  access?: Access;
  api?: FakeApi;
  store?: S;
  stateDir?: string;
  fetchImpl?: typeof fetch;
}) {
  const access = opts.access ?? makeAccess();
  const api = opts.api ?? new FakeApi();
  const store = (opts.store ?? new FakeStore()) as S;
  const stateDir = opts.stateDir ?? tmpDir("state");
  const sender = createOutboundSender({
    botId: "bot-03",
    api,
    store,
    access: () => access,
    stateDir,
    token: "TEST:TOKEN",
    fetchImpl: opts.fetchImpl,
  });
  return { sender, api, store, stateDir, access };
}

// ---------------------------------------------------------------------------
// reply: chunking, order, buttons on last chunk only, per-chunk logging.
// ---------------------------------------------------------------------------

describe("outbound: reply chunking + buttons + logging", () => {
  test("long text splits into ordered chunks; buttons attach only to the last chunk; each chunk is logged", async () => {
    const access = makeAccess({ textChunkLimit: 20, chunkMode: "length" });
    const { sender, api, store } = makeSender({ access });

    const text = "x".repeat(45); // -> 20 + 20 + 5
    const result = await sender.handle({
      op: "reply",
      chat_id: "u1",
      text,
      buttons: [[{ label: "Yes", callback_id: "yes" }]],
    });

    expect(result).toBe("sent 3 parts");
    expect(api.sendMessageCalls.map(c => c.text)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(5)]);

    // Buttons only on the last call.
    expect(api.sendMessageCalls[0]!.other?.reply_markup).toBeUndefined();
    expect(api.sendMessageCalls[1]!.other?.reply_markup).toBeUndefined();
    expect(api.sendMessageCalls[2]!.other?.reply_markup).toBeDefined();

    // One store.logOutbound call per chunk, same order, increasing ts.
    expect(store.logs).toHaveLength(3);
    expect(store.logs.map(l => l.body)).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(5)]);
    expect(store.logs[0]!.ts).toBeLessThan(store.logs[1]!.ts);
    expect(store.logs[1]!.ts).toBeLessThan(store.logs[2]!.ts);
    for (const l of store.logs) expect(l.source).toBe("assistant");
  });

  test("single-chunk reply returns 'sent (id: N)'", async () => {
    const { sender, api } = makeSender({});
    const result = await sender.handle({ op: "reply", chat_id: "u1", text: "hi" });
    expect(result).toBe("sent (id: 1)");
    expect(api.sendMessageCalls).toHaveLength(1);
  });

  test("files are sent after all text chunks, in order", async () => {
    const stateDir = tmpDir("state-files");
    fs.mkdirSync(path.join(stateDir, "inbox"), { recursive: true });
    const photo = path.join(stateDir, "inbox", "pic.jpg");
    const doc = path.join(stateDir, "inbox", "notes.txt");
    fs.writeFileSync(photo, "fake-jpg-bytes");
    fs.writeFileSync(doc, "fake-doc-bytes");

    const { sender, api, store } = makeSender({ stateDir });
    const result = await sender.handle({
      op: "reply",
      chat_id: "u1",
      text: "see attached",
      files: [photo, doc],
    });

    expect(api.sendMessageCalls).toHaveLength(1);
    expect(api.sendPhotoCalls).toHaveLength(1);
    expect(api.sendPhotoCalls[0]!.input).toBeInstanceOf(InputFile);
    expect(api.sendDocumentCalls).toHaveLength(1);
    expect(result).toBe("sent 3 parts");

    // logs: 1 text chunk + 2 files, files carry attachments not body.
    expect(store.logs).toHaveLength(3);
    expect(store.logs[1]!.attachments).toEqual([{ type: "photo", path: photo }]);
    expect(store.logs[2]!.attachments).toEqual([{ type: "document", path: doc }]);
  });
});

// ---------------------------------------------------------------------------
// reply: format markdown -> MarkdownV2 + per-chunk parse-error fallback.
// ---------------------------------------------------------------------------

describe("outbound: reply format:'markdown' MV2 convert + SCAR-048 fallback", () => {
  test("markdown converts to MarkdownV2 and sends with parse_mode", async () => {
    const { sender, api } = makeSender({});
    await sender.handle({ op: "reply", chat_id: "u1", text: "*bold* and _em_", format: "markdown" });

    expect(api.sendMessageCalls).toHaveLength(1);
    expect(api.sendMessageCalls[0]!.other?.parse_mode).toBe("MarkdownV2");
    // Converted text differs from the raw CommonMark input (escaping applied).
    expect(api.sendMessageCalls[0]!.text).not.toBe("*bold* and _em_");
  });

  test("when Telegram rejects entities, the chunk is resent as plain text (SCAR-048)", async () => {
    const { sender, api, store } = makeSender({});
    api.failParseAt.add(0); // first sendMessage call throws a parse-entities error

    const result = await sender.handle({
      op: "reply",
      chat_id: "u1",
      text: "*bold*",
      format: "markdown",
    });

    expect(result).toBe("sent (id: 1)");
    expect(api.sendMessageCalls).toHaveLength(2); // failed MV2 attempt + plain retry
    expect(api.sendMessageCalls[0]!.other?.parse_mode).toBe("MarkdownV2");
    expect(api.sendMessageCalls[1]!.other?.parse_mode).toBeUndefined();
    expect(api.sendMessageCalls[1]!.text).toBe("*bold*"); // raw CommonMark, unescaped

    // Only ONE log row for this one logical chunk (not one per API attempt).
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]!.body).toBe("*bold*");
  });

  test("a non-parse-entities error from sendMessage is not swallowed", async () => {
    const api = new FakeApi();
    const original = api.sendMessage.bind(api);
    api.sendMessage = async (...args: Parameters<OutboundApi["sendMessage"]>) => {
      await original(...args);
      throw new Error("network blip");
    };
    const { sender } = makeSender({ api });

    await expect(
      sender.handle({ op: "reply", chat_id: "u1", text: "hello", format: "markdown" }),
    ).rejects.toThrow(/network blip/);
  });
});

// ---------------------------------------------------------------------------
// reply: SCAR-062 buttons ⊕ files mutual exclusion.
// ---------------------------------------------------------------------------

describe("outbound: reply — SCAR-062 buttons/files mutual exclusion", () => {
  test("buttons + files together are rejected", async () => {
    const stateDir = tmpDir("state-mutex");
    fs.mkdirSync(path.join(stateDir, "inbox"), { recursive: true });
    const file = path.join(stateDir, "inbox", "a.txt");
    fs.writeFileSync(file, "data");

    const { sender } = makeSender({ stateDir });
    await expect(
      sender.handle({
        op: "reply",
        chat_id: "u1",
        text: "hi",
        files: [file],
        buttons: [[{ label: "Yes", callback_id: "yes" }]],
      }),
    ).rejects.toThrow(/cannot be combined/);
  });

  test("invalid button shape is rejected (callback_id regex / row-column caps)", async () => {
    const { sender } = makeSender({});
    await expect(
      sender.handle({
        op: "reply",
        chat_id: "u1",
        text: "hi",
        buttons: [[{ label: "Yes", callback_id: "NOT VALID!" }]],
      }),
    ).rejects.toThrow(/invalid buttons/);
  });

  test("reply to a chat outside allowFrom/groups is rejected", async () => {
    const { sender } = makeSender({});
    await expect(sender.handle({ op: "reply", chat_id: "stranger", text: "hi" })).rejects.toThrow(
      /not allowlisted/,
    );
  });
});

// ---------------------------------------------------------------------------
// react: SCAR-053 emoji whitelist.
// ---------------------------------------------------------------------------

describe("outbound: react — SCAR-053 emoji whitelist", () => {
  test("whitelisted emoji is accepted and forwarded to setMessageReaction", async () => {
    const { sender, api } = makeSender({});
    const result = await sender.handle({ op: "react", chat_id: "u1", message_id: "42", emoji: "👍" });
    expect(result).toBe("reacted");
    expect(api.reactionCalls).toHaveLength(1);
    expect(api.reactionCalls[0]).toEqual({
      chat_id: "u1",
      message_id: 42,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  });

  test("emoji outside the whitelist is rejected before calling the API", async () => {
    const { sender, api } = makeSender({});
    await expect(
      sender.handle({ op: "react", chat_id: "u1", message_id: "42", emoji: "🚀" }),
    ).rejects.toThrow(/whitelist/);
    expect(api.reactionCalls).toHaveLength(0);
  });

  test("whitelist sanity: contains the documented common set and excludes an arbitrary emoji", () => {
    expect(REACTION_EMOJI_WHITELIST.has("👍")).toBe(true);
    expect(REACTION_EMOJI_WHITELIST.has("🔥")).toBe(true);
    expect(REACTION_EMOJI_WHITELIST.has("🚀")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// anti-exfil: assertSendable — files inside stateDir root are refused,
// files inside stateDir/inbox are allowed.
// ---------------------------------------------------------------------------

describe("outbound: anti-exfil (assertSendable)", () => {
  test("a file at the stateDir root is refused", () => {
    const stateDir = tmpDir("state-exfil-root");
    const secret = path.join(stateDir, "access.json");
    fs.writeFileSync(secret, "{}");
    expect(() => assertSendable(secret, stateDir)).toThrow(/refusing to send channel state/);
  });

  test("a file inside stateDir/inbox is allowed", () => {
    const stateDir = tmpDir("state-exfil-inbox");
    const inbox = path.join(stateDir, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const downloaded = path.join(inbox, "1234-abc.jpg");
    fs.writeFileSync(downloaded, "data");
    expect(() => assertSendable(downloaded, stateDir)).not.toThrow();
  });

  test("a file entirely outside stateDir is allowed", () => {
    const stateDir = tmpDir("state-exfil-outside");
    const outside = tmpDir("outside-file-holder");
    const f = path.join(outside, "report.pdf");
    fs.writeFileSync(f, "data");
    expect(() => assertSendable(f, stateDir)).not.toThrow();
  });

  test("reply() end-to-end: file at stateDir root is rejected via handle()", async () => {
    const stateDir = tmpDir("state-exfil-e2e");
    const secret = path.join(stateDir, "access.json");
    fs.writeFileSync(secret, "{}");
    const { sender } = makeSender({ stateDir });
    await expect(
      sender.handle({ op: "reply", chat_id: "u1", text: "leak?", files: [secret] }),
    ).rejects.toThrow(/refusing to send channel state/);
  });

  test("reply() end-to-end: file inside stateDir/inbox is accepted via handle()", async () => {
    const stateDir = tmpDir("state-exfil-e2e-ok");
    const inbox = path.join(stateDir, "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const downloaded = path.join(inbox, "1234-abc.jpg");
    fs.writeFileSync(downloaded, "data");
    const { sender, api } = makeSender({ stateDir });
    const result = await sender.handle({ op: "reply", chat_id: "u1", text: "here", files: [downloaded] });
    expect(result).toBe("sent 2 parts");
    expect(api.sendPhotoCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// download_attachment: writes to <stateDir>/inbox/<ts>-<unique>.<ext>.
// ---------------------------------------------------------------------------

describe("outbound: download_attachment", () => {
  test("downloads via injected fetchImpl and writes into stateDir/inbox", async () => {
    const stateDir = tmpDir("state-download");
    const api = new FakeApi();
    api.getFileResult = { file_path: "photos/file_1.jpg", file_unique_id: "AQAD-unique_1" };

    const fakeFetch = (async (url: string | URL) => {
      expect(String(url)).toBe("https://api.telegram.org/file/botTEST:TOKEN/photos/file_1.jpg");
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("hello-bytes").buffer,
      } as Response;
    }) as typeof fetch;

    const { sender } = makeSender({ stateDir, api, fetchImpl: fakeFetch });
    const resultPath = await sender.handle({ op: "download_attachment", file_id: "f1" });

    expect(resultPath.startsWith(path.join(stateDir, "inbox"))).toBe(true);
    expect(resultPath.endsWith(".jpg")).toBe(true);
    expect(resultPath).toContain("AQAD-unique_1");
    expect(fs.readFileSync(resultPath, "utf8")).toBe("hello-bytes");
  });

  test("a failed HTTP download throws", async () => {
    const stateDir = tmpDir("state-download-fail");
    const api = new FakeApi();
    api.getFileResult = { file_path: "docs/f.pdf", file_unique_id: "u1" };
    const fakeFetch = (async (_url: string | URL) => ({ ok: false, status: 404 }) as Response) as typeof fetch;

    const { sender } = makeSender({ stateDir, api, fetchImpl: fakeFetch });
    await expect(sender.handle({ op: "download_attachment", file_id: "f1" })).rejects.toThrow(
      /download failed: HTTP 404/,
    );
  });

  test("missing file_path from Telegram throws a clear error", async () => {
    const stateDir = tmpDir("state-download-nopath");
    const api = new FakeApi();
    api.getFileResult = {};
    const { sender } = makeSender({ stateDir, api });
    await expect(sender.handle({ op: "download_attachment", file_id: "f1" })).rejects.toThrow(
      /no file_path/,
    );
  });
});

// ---------------------------------------------------------------------------
// get_message_by_id: real store (in-memory SQLite) roundtrip.
// ---------------------------------------------------------------------------

describe("outbound: get_message_by_id — real store roundtrip", () => {
  test("a message sent via reply() can be looked up afterwards", async () => {
    const store = realStore("bot-03", "telegram");
    const { sender } = makeSender({ store });

    const sendResult = await sender.handle({ op: "reply", chat_id: "u1", text: "hello world" });
    const idMatch = /sent \(id: (\d+)\)/.exec(sendResult);
    expect(idMatch).not.toBeNull();
    const messageId = idMatch![1]!;

    const raw = await sender.handle({ op: "get_message_by_id", chat_id: "u1", message_id: messageId });
    const row = JSON.parse(raw);
    expect(row.chat_id).toBe("u1");
    expect(row.message_id).toBe(messageId);
    expect(row.body).toBe("hello world");
    expect(row.direction).toBe("out");
    expect(row.source).toBe("assistant");
  });

  test("looking up a message that was never sent throws a clear error", async () => {
    const store = realStore("bot-03", "telegram");
    const { sender } = makeSender({ store });
    await expect(
      sender.handle({ op: "get_message_by_id", chat_id: "u1", message_id: "999" }),
    ).rejects.toThrow(/no message 999 in chat u1/);
  });
});

// ---------------------------------------------------------------------------
// OutboundCommandSchema shape validation (zod discriminated union, sourced
// from @mirza-harness/shared) — bad shape throws a ZodError. Asserted via
// duck-typing (`.name` / `.issues`) rather than `instanceof ZodError`,
// because `zod` is not a direct dependency of telegram-adapter (only
// @mirza-harness/shared is) and importing it here would fail to resolve.
// ---------------------------------------------------------------------------

describe("outbound: command shape validation (OutboundCommandSchema)", () => {
  test("unknown op is rejected with a ZodError", async () => {
    const { sender } = makeSender({});
    let caught: unknown;
    try {
      await sender.handle({ op: "edit_message", chat_id: "u1", text: "hi" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name?: string }).name).toBe("ZodError");
    expect(Array.isArray((caught as { issues?: unknown }).issues)).toBe(true);
  });

  test("missing required field is rejected with a ZodError", async () => {
    const { sender } = makeSender({});
    let caught: unknown;
    try {
      await sender.handle({ op: "reply", chat_id: "u1" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name?: string }).name).toBe("ZodError");
    expect(Array.isArray((caught as { issues?: unknown }).issues)).toBe(true);
  });

  test("unrecognized key on an otherwise-valid reply command is rejected (strict schema)", async () => {
    const { sender } = makeSender({});
    let caught: unknown;
    try {
      await sender.handle({ op: "reply", chat_id: "u1", text: "hi", unexpected_field: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { name?: string }).name).toBe("ZodError");
  });
});
