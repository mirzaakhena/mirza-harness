import { describe, expect, test } from "bun:test";
import { RpcRequest, RpcEvent, RpcResponse, PIPE_NAME_DEFAULT, parseRpcMessage } from "../src/ipc";

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

  test("PIPE_NAME_DEFAULT konstanta bernilai literal backslash escape", () => {
    expect(PIPE_NAME_DEFAULT).toBe("\\\\.\\pipe\\mirza-hostd");
  });

  test("RpcSuccess dan RpcFailure parse dengan benar, extra key ditolak", () => {
    // Valid success response
    const successMsg = parseRpcMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(RpcResponse.safeParse(successMsg).success).toBe(true);

    // Valid error response
    const errorMsg = parseRpcMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}}');
    expect(RpcResponse.safeParse(errorMsg).success).toBe(true);

    // Response dengan extra key ditolak
    expect(() => parseRpcMessage('{"jsonrpc":"2.0","id":1,"result":{},"extra":1}')).toThrow();
  });
});
