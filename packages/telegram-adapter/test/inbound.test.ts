import { describe, expect, test } from "bun:test";
import { defaultAccess, type Access, type EnvelopeT } from "@mirza-harness/shared";
import { createInboundPipeline, type InboundMessage, type InboundStoreLike } from "../src/inbound";

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const NOW = 1_700_000_000_000;

interface LoggedCall {
  args: Parameters<InboundStoreLike["logInbound"]>[0];
}

function makeStore(): { store: InboundStoreLike; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  return {
    store: {
      logInbound(args) {
        calls.push({ args });
      },
    },
    calls,
  };
}

function makeEnqueue(): { enqueueEnv: (env: EnvelopeT) => void; envs: EnvelopeT[] } {
  const envs: EnvelopeT[] = [];
  return { enqueueEnv: (env: EnvelopeT) => { envs.push(env); }, envs };
}

function baseMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    chatType: "private",
    chatId: "u1",
    senderId: "u1",
    senderName: "mirza",
    messageId: "100",
    text: "halo",
    ...overrides,
  };
}

function allMetaValuesAreStrings(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) return false;
  return Object.values(meta as Record<string, unknown>).every(v => typeof v === "string");
}

describe("inbound pipeline — DM text happy path", () => {
  test("allowFrom sender: logs to store, enqueues one envelope with string-only meta", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(baseMsg({ text: "halo dari telegram" }));

    expect(outcome.type).toBe("delivered");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args.chat_id).toBe("u1");
    expect(calls[0]!.args.body).toBe("halo dari telegram");
    expect(calls[0]!.args.user_id).toBe("u1");

    expect(envs.length).toBe(1);
    const env = envs[0]!;
    expect(env.kind).toBe("channel-inbound");
    expect(env.to).toBe("bot-01");
    expect(env.from).toBe("telegram");
    expect(env.hop).toBe(0);
    expect(typeof env.id).toBe("string");

    const payload = env.payload as { content: string; meta: Record<string, unknown> };
    expect(payload.content).toBe("halo dari telegram");
    expect(payload.meta.chat_id).toBe("u1");
    expect(payload.meta.message_id).toBe("100");
    expect(payload.meta.user).toBe("mirza");
    expect(payload.meta.user_id).toBe("u1");
    expect(allMetaValuesAreStrings(payload.meta)).toBe(true);
  });
});

describe("inbound pipeline — stranger pairing", () => {
  test("stranger under dmPolicy pairing gets pairing-reply, onPending called, nothing enqueued", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing" };
    const pendingCalls: Array<{ userId: string; code: string }> = [];

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
      onPending: (userId, code) => { pendingCalls.push({ userId, code }); },
    });

    const outcome = await handle(baseMsg({ senderId: "stranger-1", chatId: "stranger-1" }));

    expect(outcome.type).toBe("pairing-reply");
    if (outcome.type === "pairing-reply") {
      expect(outcome.isResend).toBe(false);
      expect(outcome.text).toContain("/telegram:access pair");
      expect(outcome.text).toContain(outcome.code);
    }
    expect(pendingCalls.length).toBe(1);
    expect(pendingCalls[0]!.userId).toBe("stranger-1");

    expect(calls.length).toBe(0);
    expect(envs.length).toBe(0);
  });

  test("resend (existing active pending) does NOT call onPending again", async () => {
    const { store } = makeStore();
    const { enqueueEnv } = makeEnqueue();
    const access: Access = {
      ...defaultAccess(),
      dmPolicy: "pairing",
      pending: {
        abc123: { senderId: "stranger-1", chatId: "stranger-1", createdAt: NOW, expiresAt: NOW + 1000, replies: 1 },
      },
    };
    const pendingCalls: Array<{ userId: string; code: string }> = [];

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
      onPending: (userId, code) => { pendingCalls.push({ userId, code }); },
    });

    const outcome = await handle(baseMsg({ senderId: "stranger-1", chatId: "stranger-1" }));

    expect(outcome.type).toBe("pairing-reply");
    if (outcome.type === "pairing-reply") {
      expect(outcome.isResend).toBe(true);
      expect(outcome.code).toBe("abc123");
    }
    expect(pendingCalls.length).toBe(0);
  });
});

describe("inbound pipeline — dmPolicy disabled", () => {
  test("drops without touching store or bus", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "disabled", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(baseMsg());

    expect(outcome.type).toBe("dropped");
    expect(calls.length).toBe(0);
    expect(envs.length).toBe(0);
  });
});

describe("inbound pipeline — album (SCAR-055/SCAR-056)", () => {
  test("3 photos -> ONE envelope, sorted by message_id, meta matches kode acuan convention", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const downloaded: string[] = [];
    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
      downloadFile: async (fileId: string) => {
        const path = `/tmp/${fileId}.jpg`;
        downloaded.push(path);
        return path;
      },
    });

    // Arrive out of order (103, 101, 102) — sort must fix this to 101,102,103.
    const outcomes = await Promise.all([
      handle(baseMsg({ messageId: "103", mediaGroupId: "mg1", photo: { fileId: "file-103" }, text: "Photo 3 caption" })),
      handle(baseMsg({ messageId: "101", mediaGroupId: "mg1", photo: { fileId: "file-101" }, text: undefined, quote: { text: "original", isManual: true } })),
      handle(baseMsg({ messageId: "102", mediaGroupId: "mg1", photo: { fileId: "file-102" }, text: undefined })),
    ]);

    for (const o of outcomes) expect(o.type).toBe("buffered");

    // Debounce is 400ms (kode acuan constant) — wait past it.
    await wait(600);

    expect(envs.length).toBe(1);
    expect(calls.length).toBe(1);

    const logArgs = calls[0]!.args;
    expect(logArgs.message_id).toBe("101"); // first item after sort
    expect((logArgs.metadata as { message_ids: string[] }).message_ids).toEqual(["101", "102", "103"]);
    expect((logArgs.metadata as { media_group_id: string }).media_group_id).toBe("mg1");
    // Quote only taken from the first item after sort (message_id 101).
    expect(logArgs.quote_text).toBe("original");
    expect(logArgs.quote_is_manual).toBe(true);

    const env = envs[0]!;
    expect(env.kind).toBe("channel-inbound");
    const payload = env.payload as { content: string; meta: Record<string, unknown> };
    expect(payload.meta.media_group_id).toBe("mg1");
    expect(payload.meta.message_ids).toBe("101,102,103");
    expect(payload.meta.image_paths).toBe(
      ["/tmp/file-101.jpg", "/tmp/file-102.jpg", "/tmp/file-103.jpg"].join("\n"),
    );
    expect(payload.meta.quote_text).toBe("original");
    expect(payload.meta.quote_is_manual).toBe("true");
    expect(allMetaValuesAreStrings(payload.meta)).toBe(true);
  });
});

describe("inbound pipeline — ai:* callback tap", () => {
  test("produces [button tapped: label] envelope with callback_id in meta", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(
      baseMsg({ text: undefined, callback: { data: "ai:confirm_yes", buttonLabel: "Yes, proceed" } }),
    );

    expect(outcome.type).toBe("delivered");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args.body).toBe("[button tapped: Yes, proceed]");

    expect(envs.length).toBe(1);
    const payload = envs[0]!.payload as { content: string; meta: Record<string, unknown> };
    expect(payload.content).toBe("[button tapped: Yes, proceed]");
    expect(payload.meta.callback_id).toBe("confirm_yes");
    expect(payload.meta.button_label).toBe("Yes, proceed");
    expect(allMetaValuesAreStrings(payload.meta)).toBe(true);
  });

  test("non ai:* callback (e.g. perm:*) is dropped, out of Fase-1 scope", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(baseMsg({ text: undefined, callback: { data: "perm:allow:abcde" } }));

    expect(outcome.type).toBe("dropped");
    expect(calls.length).toBe(0);
    expect(envs.length).toBe(0);
  });
});

describe("inbound pipeline — meta-command flag (fase 1 stub)", () => {
  test("known meta command from allowFrom sender delivers with meta.note stamped", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(baseMsg({ text: "/new some-session" }));

    expect(outcome.type).toBe("delivered");
    expect(calls.length).toBe(1);
    const payload = envs[0]!.payload as { content: string; meta: Record<string, unknown> };
    expect(payload.content).toBe("/new some-session");
    expect(payload.meta.note).toBe("meta-command-unhandled-fase1");
    expect(allMetaValuesAreStrings(payload.meta)).toBe(true);
  });
});

describe("inbound pipeline — SEC-1 isInfoCommand wired into gate()", () => {
  test("'/context' in a group (requireMention:false, sender in group allowFrom) is dropped — info commands are DM-only", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = {
      ...defaultAccess(),
      groups: { g1: { requireMention: false, allowFrom: ["u1"] } },
    };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(
      baseMsg({ chatType: "group", chatId: "g1", senderId: "u1", text: "/context" }),
    );

    expect(outcome.type).toBe("dropped");
    expect(calls.length).toBe(0);
    expect(envs.length).toBe(0);
  });
});

describe("inbound pipeline — isKnownMetaCommand exact-match (not \\b prefix)", () => {
  test("'/new-onboarding' is NOT treated as a meta-command (no meta.note stamp)", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(baseMsg({ text: "/new-onboarding" }));

    expect(outcome.type).toBe("delivered");
    expect(calls.length).toBe(1);
    const payload = envs[0]!.payload as { content: string; meta: Record<string, unknown> };
    expect(payload.meta.note).toBeUndefined();
  });
});

describe("inbound pipeline — replyToMessageId forwarded to store as reply_to", () => {
  test("reply to a photo with no caption (quote undefined, replyToMessageId set) -> logInbound gets reply_to", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
      downloadFile: async (fileId: string) => `/tmp/${fileId}.jpg`,
    });

    const outcome = await handle(
      baseMsg({ text: undefined, photo: { fileId: "file-1" }, quote: undefined, replyToMessageId: "99" }),
    );

    expect(outcome.type).toBe("delivered");
    expect(calls.length).toBe(1);
    expect(calls[0]!.args.reply_to).toBe("99");
    expect(calls[0]!.args.quote_text).toBeUndefined();
  });
});

describe("inbound pipeline — FUNC-1 guard", () => {
  test("null payload does not crash, is dropped with a reason", async () => {
    const { store, calls } = makeStore();
    const { enqueueEnv, envs } = makeEnqueue();
    const access: Access = { ...defaultAccess(), dmPolicy: "pairing", allowFrom: ["u1"] };

    const handle = createInboundPipeline({
      botId: "bot-01",
      access: () => access,
      store,
      enqueueEnv,
      now: () => NOW,
    });

    const outcome = await handle(null);
    expect(outcome.type).toBe("dropped");
    expect(calls.length).toBe(0);
    expect(envs.length).toBe(0);
  });
});
