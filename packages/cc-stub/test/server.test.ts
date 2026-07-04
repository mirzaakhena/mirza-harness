import { describe, expect, test } from "bun:test";
import { makeChannelDeliverHandler, makeEventRouter, type McpNotifier } from "../src/server";

function mockMcp(): { mcp: McpNotifier; notifications: { method: string; params?: unknown }[] } {
  const notifications: { method: string; params?: unknown }[] = [];
  return {
    mcp: {
      notification: async n => {
        notifications.push(n);
      },
    },
    notifications,
  };
}

describe("makeChannelDeliverHandler", () => {
  test("payload valid -> emit notifications/claude/channel dgn content+meta, lalu confirm dgn envelope_id+attempt_token", async () => {
    const { mcp, notifications } = mockMcp();
    const confirmed: { envelopeId: string; attemptToken: string }[] = [];
    const handler = makeChannelDeliverHandler({
      mcp,
      confirm: async (envelopeId, attemptToken) => {
        confirmed.push({ envelopeId, attemptToken });
        return { ok: true };
      },
    });

    await handler({ envelope_id: "env-1", attempt_token: "tok-1", content: "halo", meta: { chat_id: "123", user: "mirza" } });

    expect(notifications).toEqual([
      { method: "notifications/claude/channel", params: { content: "halo", meta: { chat_id: "123", user: "mirza" } } },
    ]);
    expect(confirmed).toEqual([{ envelopeId: "env-1", attemptToken: "tok-1" }]);
  });

  test("meta diteruskan apa adanya (stub tak mengubah bentuk/isi meta)", async () => {
    const { mcp, notifications } = mockMcp();
    const handler = makeChannelDeliverHandler({ mcp, confirm: async () => undefined });
    const meta = { channel: "telegram", chat_id: "999", quote_text: "abc", weird_key: "x" };

    await handler({ envelope_id: "e", attempt_token: "tok-e", content: "c", meta });

    expect((notifications[0]!.params as { meta: unknown }).meta).toEqual(meta);
  });

  test("payload invalid (meta bukan Record<string,string>) -> onError, notification & confirm TIDAK dipanggil", async () => {
    const { mcp, notifications } = mockMcp();
    const confirmed: string[] = [];
    const errors: string[] = [];
    const handler = makeChannelDeliverHandler({
      mcp,
      confirm: async envelopeId => {
        confirmed.push(envelopeId);
      },
      onError: msg => errors.push(msg),
    });

    await handler({ envelope_id: "e", attempt_token: "tok-e", content: "c", meta: { count: 5 } });

    expect(notifications.length).toBe(0);
    expect(confirmed.length).toBe(0);
    expect(errors.length).toBe(1);
  });

  test("payload tanpa envelope_id -> onError, tak diteruskan", async () => {
    const { mcp, notifications } = mockMcp();
    const errors: string[] = [];
    const handler = makeChannelDeliverHandler({ mcp, confirm: async () => undefined, onError: msg => errors.push(msg) });

    await handler({ attempt_token: "tok-e", content: "c", meta: {} });

    expect(notifications.length).toBe(0);
    expect(errors.length).toBe(1);
  });

  test("payload tanpa attempt_token -> onError, tak diteruskan", async () => {
    const { mcp, notifications } = mockMcp();
    const errors: string[] = [];
    const handler = makeChannelDeliverHandler({ mcp, confirm: async () => undefined, onError: msg => errors.push(msg) });

    await handler({ envelope_id: "e", content: "c", meta: {} });

    expect(notifications.length).toBe(0);
    expect(errors.length).toBe(1);
  });

  test("confirm gagal (reject) -> onError dipanggil, tapi notification tetap sudah terkirim lebih dulu", async () => {
    const { mcp, notifications } = mockMcp();
    const errors: string[] = [];
    const handler = makeChannelDeliverHandler({
      mcp,
      confirm: async () => {
        throw new Error("hostd unreachable");
      },
      onError: msg => errors.push(msg),
    });

    await handler({ envelope_id: "e", attempt_token: "tok-e", content: "c", meta: {} });

    expect(notifications.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("hostd unreachable");
  });
});

describe("makeEventRouter", () => {
  test("hanya method channel.deliver yang memicu handler; method lain diabaikan", async () => {
    const { mcp, notifications } = mockMcp();
    const confirmed: string[] = [];
    const onEvent = makeEventRouter({
      mcp,
      confirm: async envelopeId => {
        confirmed.push(envelopeId);
      },
    });

    onEvent("some.other.event", { x: 1 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(notifications.length).toBe(0);

    onEvent("channel.deliver", { envelope_id: "e2", attempt_token: "tok-2", content: "hai", meta: {} });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(notifications.length).toBe(1);
    expect(confirmed).toEqual(["e2"]);
  });
});
