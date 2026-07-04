import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { startServer } from "../src/server";

const TEST_PIPE = `\\\\.\\pipe\\mirza-hostd-test-${process.pid}`;

function rpcCall(pipe: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe, () => sock.write(JSON.stringify(payload) + "\n"));
    let buf = "";
    sock.on("data", d => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 5000);
  });
}

describe("hostd server", () => {
  let server: net.Server;
  afterAll(() => server?.close());

  test("doctor dijawab lewat pipe", async () => {
    server = await startServer(TEST_PIPE);
    const res = await rpcCall(TEST_PIPE, { jsonrpc: "2.0", id: 1, method: "doctor" });
    expect(res.id).toBe(1);
    expect(res.result.ok).toBe(true);
    expect(res.result.components.bus).toBe("stub");
  });

  test("method tak dikenal → error -32601 (bukan ditelan)", async () => {
    const res = await rpcCall(TEST_PIPE, { jsonrpc: "2.0", id: 2, method: "belum_ada" });
    expect(res.error.code).toBe(-32601);
  });

  test("payload invalid → error -32700/-32600 (bukan crash)", async () => {
    const res = await rpcCall(TEST_PIPE, { hello: "dunia" });
    expect(res.error.code).toBeLessThanOrEqual(-32600);
  });
});
