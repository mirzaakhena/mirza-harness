import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { startServer, pushEvent, isRegistered } from "../src/server";

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

/** Reader NDJSON single-listener: hindari stacking listener bila dibaca berkali-kali dari satu socket. */
function makeLineReader(sock: net.Socket) {
  const queue: unknown[] = [];
  let waiter: ((msg: unknown) => void) | null = null;
  let buf = "";
  sock.on("data", d => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else {
        queue.push(msg);
      }
    }
  });
  return {
    next(): Promise<any> {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return Promise.race([
        new Promise(resolve => { waiter = resolve; }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout menunggu pesan")), 5000)),
      ]);
    },
  };
}

describe("session.register + pushEvent roundtrip", () => {
  const REGISTER_PIPE = `\\\\.\\pipe\\mirza-hostd-test-register-${process.pid}`;
  let server: net.Server;
  afterAll(() => server?.close());

  test("register socket lalu pushEvent mengirim notification NDJSON ke koneksi terdaftar", async () => {
    server = await startServer(REGISTER_PIPE);
    const botId = `cc-stub-${process.pid}`;

    expect(isRegistered(botId)).toBe(false);
    expect(pushEvent(botId, "channel.deliver", { x: 1 })).toBe(false);

    const sock = net.connect(REGISTER_PIPE);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    const reader = makeLineReader(sock);

    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.register", params: { bot_id: botId } }) + "\n");
    const registerRes = await reader.next();
    expect(registerRes.id).toBe(1);
    expect(registerRes.result).toEqual({ registered: true, bot_id: botId });
    expect(isRegistered(botId)).toBe(true);

    // doctor lama tetap bekerja lewat koneksi yang sama (backward-compat)
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "doctor" }) + "\n");
    const doctorRes = await reader.next();
    expect(doctorRes.result.ok).toBe(true);

    const sent = pushEvent(botId, "channel.deliver", { content: "halo", meta: { a: "b" } });
    expect(sent).toBe(true);

    const eventMsg = await reader.next();
    expect(eventMsg.id).toBeUndefined();
    expect(eventMsg.jsonrpc).toBe("2.0");
    expect(eventMsg.method).toBe("channel.deliver");
    expect(eventMsg.params).toEqual({ content: "halo", meta: { a: "b" } });

    sock.end();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(isRegistered(botId)).toBe(false);
    expect(pushEvent(botId, "channel.deliver", {})).toBe(false);
  });

  test("session.register tanpa bot_id → error terlihat, bukan ditelan", async () => {
    const res = await rpcCall(REGISTER_PIPE, { jsonrpc: "2.0", id: 3, method: "session.register", params: {} });
    expect(res.error).toBeDefined();
  });
});
