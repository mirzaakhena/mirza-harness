import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import { mapCtxToInboundMessage } from "../src/adapters/ctx-map";

/** Build a minimal fake grammy Context — only the getters ctx-map.ts reads. */
function fakeCtx(overrides: Partial<{ message: unknown; callbackQuery: unknown; chat: unknown; from: unknown }>): Context {
  return {
    message: overrides.message,
    callbackQuery: overrides.callbackQuery,
    chat: overrides.chat,
    from: overrides.from,
  } as unknown as Context;
}

const CHAT_PRIVATE = { id: 555, type: "private" as const };
const USER = { id: 111, username: "mirza", first_name: "Mirza" };

describe("mapCtxToInboundMessage — text messages", () => {
  test("plain text message maps every field, ts converted seconds->ms", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 42, text: "halo bot", date: 1_700_000_000 },
    });

    const msg = mapCtxToInboundMessage(ctx);

    expect(msg).toEqual({
      chatType: "private",
      chatId: "555",
      senderId: "111",
      senderName: "mirza",
      messageId: "42",
      text: "halo bot",
      photo: undefined,
      document: undefined,
      quote: undefined,
      mediaGroupId: undefined,
      ts: 1_700_000_000_000,
      replyToMessageId: undefined,
    });
  });

  test("senderName falls back to first_name when username absent", () => {
    const ctx = fakeCtx({ chat: CHAT_PRIVATE, from: { id: 111, first_name: "Mirza" }, message: { message_id: 1, text: "hi", date: 1 } });
    expect(mapCtxToInboundMessage(ctx)?.senderName).toBe("Mirza");
  });

  test("group chat @botname suffix stripped from a leading command token", () => {
    const ctx = fakeCtx({
      chat: { id: -100, type: "group" },
      from: USER,
      message: { message_id: 2, text: "/start@my_cool_bot with args", date: 1 },
    });
    expect(mapCtxToInboundMessage(ctx)?.text).toBe("/start with args");
  });

  test("non-command text is left untouched (no accidental @ stripping mid-sentence)", () => {
    const ctx = fakeCtx({ chat: CHAT_PRIVATE, from: USER, message: { message_id: 3, text: "email me at foo@bar.com", date: 1 } });
    expect(mapCtxToInboundMessage(ctx)?.text).toBe("email me at foo@bar.com");
  });

  test("caption used as text when no text field (media message)", () => {
    const ctx = fakeCtx({ chat: CHAT_PRIVATE, from: USER, message: { message_id: 4, caption: "a photo caption", date: 1, photo: [{ file_id: "p1" }] } });
    expect(mapCtxToInboundMessage(ctx)?.text).toBe("a photo caption");
  });

  test("photo: best (last) resolution file_id picked", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 5, date: 1, photo: [{ file_id: "small" }, { file_id: "medium" }, { file_id: "large" }] },
    });
    expect(mapCtxToInboundMessage(ctx)?.photo).toEqual({ fileId: "large" });
  });

  test("document mapped with size/mime/name when present", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 6, date: 1, document: { file_id: "d1", file_size: 1024, mime_type: "application/pdf", file_name: "a.pdf" } },
    });
    expect(mapCtxToInboundMessage(ctx)?.document).toEqual({ fileId: "d1", size: 1024, mime: "application/pdf", name: "a.pdf" });
  });

  test("media_group_id and reply_to_message.message_id carried through", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 7, date: 1, media_group_id: "mg1", reply_to_message: { message_id: 6 } },
    });
    const msg = mapCtxToInboundMessage(ctx)!;
    expect(msg.mediaGroupId).toBe("mg1");
    expect(msg.replyToMessageId).toBe("6");
  });

  test("quote: manual partial-selection quote wins over reply_to_message text", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: {
        message_id: 8,
        date: 1,
        text: "reply",
        quote: { text: "the highlighted part", is_manual: true },
        reply_to_message: { text: "full original message" },
      },
    });
    expect(mapCtxToInboundMessage(ctx)?.quote).toEqual({ text: "the highlighted part", isManual: true });
  });

  test("quote: falls back to reply_to_message.text (isManual false) when no manual quote", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 9, date: 1, reply_to_message: { text: "original text" } },
    });
    expect(mapCtxToInboundMessage(ctx)?.quote).toEqual({ text: "original text", isManual: false });
  });

  test("quote: falls back to reply_to_message.caption when no text", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 10, date: 1, reply_to_message: { caption: "photo caption" } },
    });
    expect(mapCtxToInboundMessage(ctx)?.quote).toEqual({ text: "photo caption", isManual: false });
  });

  test("no chat/from -> undefined (defensive, shouldn't crash)", () => {
    expect(mapCtxToInboundMessage(fakeCtx({ message: { message_id: 1, date: 1 } }))).toBeUndefined();
  });

  test("neither message nor callbackQuery -> undefined", () => {
    expect(mapCtxToInboundMessage(fakeCtx({}))).toBeUndefined();
  });
});

describe("mapCtxToInboundMessage — callback queries", () => {
  test("ai:* callback tap maps to InboundMessage.callback with resolved button label", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      callbackQuery: {
        data: "ai:yes",
        message: {
          message_id: 20,
          date: 1_700_000_100,
          reply_markup: { inline_keyboard: [[{ text: "Yes please", callback_data: "ai:yes" }]] },
        },
      },
    });

    const msg = mapCtxToInboundMessage(ctx);

    expect(msg).toEqual({
      chatType: "private",
      chatId: "555",
      senderId: "111",
      senderName: "mirza",
      messageId: "20",
      callback: { data: "ai:yes", buttonLabel: "Yes please" },
      ts: 1_700_000_100_000,
    });
  });

  test("callback without a matching button in the keyboard -> no buttonLabel", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      callbackQuery: { data: "ai:mystery", message: { message_id: 21, date: 1, reply_markup: { inline_keyboard: [] } } },
    });
    expect(mapCtxToInboundMessage(ctx)?.callback).toEqual({ data: "ai:mystery" });
  });

  test("callback with no data (e.g. a game callback) -> undefined", () => {
    const ctx = fakeCtx({ chat: CHAT_PRIVATE, from: USER, callbackQuery: { game_short_name: "snake", message: { message_id: 22, date: 1 } } });
    expect(mapCtxToInboundMessage(ctx)).toBeUndefined();
  });

  test("callbackQuery takes precedence over message when (hypothetically) both are present", () => {
    const ctx = fakeCtx({
      chat: CHAT_PRIVATE,
      from: USER,
      message: { message_id: 1, text: "should be ignored", date: 1 },
      callbackQuery: { data: "ai:x", message: { message_id: 2, date: 1 } },
    });
    expect(mapCtxToInboundMessage(ctx)?.callback).toEqual({ data: "ai:x" });
  });
});
