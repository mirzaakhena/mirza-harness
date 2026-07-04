import { describe, expect, test } from "bun:test";
import { RpcRequest, RpcEvent, parseRpcMessage } from "../src/ipc";

describe("ipc schemas", () => {
  test("request valid lolos parse", () => {
    const msg = parseRpcMessage('{"jsonrpc":"2.0","id":1,"method":"doctor"}');
    expect(RpcRequest.safeParse(msg).success).toBe(true);
  });

  test("event (tanpa id) terbedakan dari request", () => {
    const msg = parseRpcMessage('{"jsonrpc":"2.0","method":"session.start","params":{"session_id":"abc"}}');
    expect(RpcEvent.safeParse(msg).success).toBe(true);
    expect(RpcRequest.safeParse(msg).success).toBe(false);
  });

  test("payload tak dikenal ditolak, bukan ditelan", () => {
    expect(() => parseRpcMessage('{"hello":"world"}')).toThrow();
    expect(() => parseRpcMessage("bukan json")).toThrow();
  });
});
