import { describe, expect, test } from "bun:test";
import net from "node:net";
import { connectHostd, type HostdStatus } from "../src/ipc-client";

interface RegisteredParams {
  bot_id: string;
}

interface MockHostd {
  server: net.Server;
  registrations: RegisteredParams[];
  sockets: net.Socket[];
  setHandler(fn: ((msg: any, sock: net.Socket) => void) | null): void;
}

/** Server pipe minimal yang meniru hostd: balas session.register, dan biarkan
 * test menyuntik handler kustom utk method lain / push event kapan saja. */
function startMockHostd(pipeName: string): Promise<MockHostd> {
  return new Promise((resolve, reject) => {
    const registrations: RegisteredParams[] = [];
    const sockets: net.Socket[] = [];
    let handler: ((msg: any, sock: net.Socket) => void) | null = null;

    const server = net.createServer(sock => {
      sockets.push(sock);
      let buf = "";
      sock.on("data", d => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.method === "session.register") {
            registrations.push(msg.params);
            sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { registered: true, bot_id: msg.params.bot_id } }) + "\n");
          } else if (handler) {
            handler(msg, sock);
          }
        }
      });
    });
    server.on("error", reject);
    server.listen(pipeName, () => resolve({ server, registrations, sockets, setHandler: fn => { handler = fn; } }));
  });
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("waitFor: timeout menunggu kondisi"));
      }
    }, 10);
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

/**
 * `net.Server.prototype.close()` hanya berhenti MENERIMA koneksi baru — ia
 * TIDAK memutus socket yang sudah diterima (mereka tetap "connected" dari
 * sisi client sampai socket itu sendiri ditutup). Utk mensimulasikan hostd
 * mati/direstart (client harus mendeteksi putus & reconnect), kita perlu
 * secara eksplisit destroy tiap socket yang sudah diterima juga.
 */
function shutdownMock(mock: MockHostd): Promise<void> {
  for (const s of mock.sockets) s.destroy();
  return closeServer(mock.server);
}

describe("connectHostd — session.register saat connect", () => {
  test("connect -> session.register terkirim dgn bot_id yg diberikan", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-register-${process.pid}`;
    const mock = await startMockHostd(pipeName);
    const client = connectHostd({ pipeName, botId: "bot-99", onEvent: () => {} });

    await waitFor(() => mock.registrations.length >= 1);
    expect(mock.registrations[0]).toEqual({ bot_id: "bot-99" });

    client.close();
    await closeServer(mock.server);
  });
});

describe("connectHostd — event pass-through", () => {
  test("event channel.deliver dari hostd diteruskan apa adanya ke onEvent", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-event-${process.pid}`;
    const mock = await startMockHostd(pipeName);
    const events: { method: string; params: unknown }[] = [];
    const client = connectHostd({ pipeName, botId: "bot-1", onEvent: (method, params) => events.push({ method, params }) });

    await waitFor(() => mock.registrations.length >= 1);
    mock.sockets[0].write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "channel.deliver",
        params: { envelope_id: "e1", content: "halo", meta: { a: "b" } },
      }) + "\n",
    );

    await waitFor(() => events.length >= 1);
    expect(events[0]).toEqual({
      method: "channel.deliver",
      params: { envelope_id: "e1", content: "halo", meta: { a: "b" } },
    });

    client.close();
    await closeServer(mock.server);
  });
});

describe("connectHostd — call() roundtrip", () => {
  test("call() mengirim request ber-id dan resolve dgn result balasan yg berkorelasi", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-call-${process.pid}`;
    const mock = await startMockHostd(pipeName);
    mock.setHandler((msg, sock) => {
      if (msg.method === "channel.confirm") {
        sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { confirmed: true, envelope_id: msg.params.envelope_id } }) + "\n");
      }
    });
    const client = connectHostd({ pipeName, botId: "bot-1", onEvent: () => {} });
    await waitFor(() => mock.registrations.length >= 1);

    const result = await client.call("channel.confirm", { envelope_id: "e-77" });
    expect(result).toEqual({ confirmed: true, envelope_id: "e-77" });

    client.close();
    await closeServer(mock.server);
  });

  test("call() reject dgn pesan error server saat hostd membalas RpcFailure", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-call-err-${process.pid}`;
    const mock = await startMockHostd(pipeName);
    mock.setHandler((msg, sock) => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method tak dikenal: x" } }) + "\n");
    });
    const client = connectHostd({ pipeName, botId: "bot-1", onEvent: () => {} });
    await waitFor(() => mock.registrations.length >= 1);

    await expect(client.call("x")).rejects.toThrow("method tak dikenal: x");

    client.close();
    await closeServer(mock.server);
  });

  test("call() reject dgn 'hostd unreachable' bila tak ada koneksi aktif", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-unreachable-${process.pid}`; // sengaja: tak ada server dengar
    const statuses: HostdStatus[] = [];
    const client = connectHostd({ pipeName, botId: "bot-1", onEvent: () => {}, onStatus: s => statuses.push(s) });

    await waitFor(() => statuses.some(s => s.kind === "disconnected" || s.kind === "reconnecting"));
    await expect(client.call("whatever")).rejects.toThrow("hostd unreachable");

    client.close();
  });
});

describe("connectHostd — reconnect setelah server tertutup", () => {
  test("server close lalu hidup lagi di pipe yg sama -> client reconnect otomatis dan re-register", async () => {
    const pipeName = `\\\\.\\pipe\\cc-stub-test-reconnect-${process.pid}`;
    let mock = await startMockHostd(pipeName);
    const client = connectHostd({ pipeName, botId: "bot-reconnect", onEvent: () => {} });

    await waitFor(() => mock.registrations.length >= 1);
    expect(mock.registrations.length).toBe(1);

    await shutdownMock(mock);
    mock = await startMockHostd(pipeName);

    await waitFor(() => mock.registrations.length >= 1, 8000);
    expect(mock.registrations[0]).toEqual({ bot_id: "bot-reconnect" });

    client.close();
    await shutdownMock(mock);
  }, 15000);
});
