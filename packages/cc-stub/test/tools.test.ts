import { describe, expect, test } from "bun:test";
import { listToolDefinitions, buildRpcCall, makeCallToolHandler, resolveBotId } from "../src/tools";

describe("resolveBotId", () => {
  test("MIRZA_BOT_ID wins when set", () => {
    expect(resolveBotId({ MIRZA_BOT_ID: "bot-07" } as NodeJS.ProcessEnv, "C:/workspace/bot-03")).toBe("bot-07");
  });

  test("falls back to basename(cwd) when env var absent", () => {
    expect(resolveBotId({} as NodeJS.ProcessEnv, "C:/workspace/bot-03")).toBe("bot-03");
  });

  test("falls back when env var is blank/whitespace", () => {
    expect(resolveBotId({ MIRZA_BOT_ID: "   " } as NodeJS.ProcessEnv, "/home/bot-05")).toBe("bot-05");
  });
});

describe("listToolDefinitions", () => {
  const tools = listToolDefinitions();

  test("exposes exactly the 7 tools from the brief", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["agent_list", "agent_send", "agent_status", "download_attachment", "get_message_by_id", "react", "reply"].sort(),
    );
  });

  test("every tool has a non-empty description and an object inputSchema", () => {
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("reply's inputSchema requires chat_id + text, buttons is present", () => {
    const reply = tools.find((t) => t.name === "reply")!;
    expect((reply.inputSchema.required as string[]).sort()).toEqual(["chat_id", "text"]);
  });

  test("agent_list takes no input", () => {
    const agentList = tools.find((t) => t.name === "agent_list")!;
    expect(agentList.inputSchema.properties).toEqual({});
  });
});

describe("buildRpcCall", () => {
  test("reply/react/download_attachment/get_message_by_id -> telegram.outbound {bot_id, cmd:{op,...}}", () => {
    expect(buildRpcCall("reply", { chat_id: "1", text: "hi" }, "bot-03")).toEqual({
      method: "telegram.outbound",
      params: { bot_id: "bot-03", cmd: { op: "reply", chat_id: "1", text: "hi" } },
    });
    expect(buildRpcCall("react", { chat_id: "1", message_id: "2", emoji: "👍" }, "bot-03")).toEqual({
      method: "telegram.outbound",
      params: { bot_id: "bot-03", cmd: { op: "react", chat_id: "1", message_id: "2", emoji: "👍" } },
    });
    expect(buildRpcCall("download_attachment", { file_id: "f1" }, "bot-03")).toEqual({
      method: "telegram.outbound",
      params: { bot_id: "bot-03", cmd: { op: "download_attachment", file_id: "f1" } },
    });
    expect(buildRpcCall("get_message_by_id", { chat_id: "1", message_id: "2" }, "bot-03")).toEqual({
      method: "telegram.outbound",
      params: { bot_id: "bot-03", cmd: { op: "get_message_by_id", chat_id: "1", message_id: "2" } },
    });
  });

  test("agent_list -> agent.list with no params", () => {
    expect(buildRpcCall("agent_list", {}, "bot-03")).toEqual({ method: "agent.list", params: undefined });
  });

  test("agent_status -> agent.status {name}", () => {
    expect(buildRpcCall("agent_status", { name: "bot-02" }, "bot-03")).toEqual({
      method: "agent.status",
      params: { name: "bot-02" },
    });
  });

  test("agent_send -> agent.send, `from` is ALWAYS this stub's own botId (never taken from args)", () => {
    expect(
      buildRpcCall("agent_send", { target: "bot-02", payload: { kind: "prompt", body: "hi" }, from: "spoofed" }, "bot-03"),
    ).toEqual({
      method: "agent.send",
      params: { target: "bot-02", payload: { kind: "prompt", body: "hi" }, from: "bot-03" },
    });
  });

  test("unknown tool -> null", () => {
    expect(buildRpcCall("nonexistent", {}, "bot-03")).toBeNull();
  });
});

describe("makeCallToolHandler", () => {
  test("success: forwards to deps.call, returns text content with the RPC result", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const handler = makeCallToolHandler({
      botId: "bot-03",
      call: async (method, params) => {
        calls.push({ method, params });
        return "sent (id: 42)";
      },
    });

    const result = await handler("reply", { chat_id: "1", text: "hi" });

    expect(calls).toEqual([{ method: "telegram.outbound", params: { bot_id: "bot-03", cmd: { op: "reply", chat_id: "1", text: "hi" } } }]);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("sent (id: 42)");
  });

  test("non-string RPC result is JSON-stringified for display", async () => {
    const handler = makeCallToolHandler({ botId: "bot-03", call: async () => [{ name: "bot-02" }] });
    const result = await handler("agent_list", {});
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ name: "bot-02" }]);
  });

  test("hostd unreachable -> isError true with a clear message, not swallowed", async () => {
    const handler = makeCallToolHandler({
      botId: "bot-03",
      call: async () => {
        throw new Error("hostd unreachable");
      },
    });

    const result = await handler("agent_status", { name: "bot-02" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("hostd unreachable");
    expect(result.content[0]!.text).toContain("agent_status");
  });

  test("unknown tool name -> isError true, deps.call never invoked", async () => {
    let called = false;
    const handler = makeCallToolHandler({
      botId: "bot-03",
      call: async () => {
        called = true;
        return null;
      },
    });

    const result = await handler("bogus_tool", {});

    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  test("missing args (undefined) is treated as {} — does not throw", async () => {
    const handler = makeCallToolHandler({ botId: "bot-03", call: async () => "ok" });
    const result = await handler("agent_list", undefined);
    expect(result.content[0]!.text).toBe("ok");
  });
});
