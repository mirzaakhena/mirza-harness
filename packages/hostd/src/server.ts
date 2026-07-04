import net from "node:net";
import { z } from "zod";
import { RpcRequest, ChannelConfirmParams, type RpcEventT, parseRpcMessage } from "@mirza-harness/shared";
import { doctorReport } from "./doctor";
import { handleTelegramOutbound, handleAgentList, handleAgentStatus, handleAgentSend, type RpcHandlerDeps } from "./rpc-handlers";

type Handler = (params: unknown, sock: net.Socket) => unknown | Promise<unknown>;

/** Delegate yang dipanggil saat method `channel.confirm {envelope_id, attempt_token}` diterima. */
export type ConfirmDelegate = (envelopeId: string, attemptToken: string) => unknown;

/**
 * Registry delegate confirm — di-inject dari wiring hostd (mis. main.ts)
 * yang punya akses ke db + `confirmDelivery` (hostd/bus/delivery.ts).
 * server.ts sengaja tetap tipis: tidak tahu apa-apa soal db/bus_queue,
 * hanya mendelegasikan. `null` (belum ter-wiring) -> method
 * `channel.confirm` menjawab error terlihat, bukan diam-diam sukses.
 */
let confirmDelegate: ConfirmDelegate | null = null;

/** Daftarkan (atau lepas dgn `null`) delegate `channel.confirm`. Registrasi baru menimpa yang lama. */
export function registerConfirmHandler(delegate: ConfirmDelegate | null): void {
  confirmDelegate = delegate;
}

/**
 * Registry deps untuk method RPC Task D2 (`telegram.outbound`/`agent.list`/
 * `agent.status`/`agent.send`) — sama pola dgn `confirmDelegate` di atas:
 * di-inject dari wiring (main.ts) yang punya akses db/config/senders/statuses
 * nyata. `null` (belum ter-wiring) -> method-method ini menjawab error
 * terlihat, bukan diam-diam sukses/kosong (prinsip §2.5).
 */
let rpcDeps: RpcHandlerDeps | null = null;

/** Daftarkan (atau lepas dgn `null`) deps untuk rpc-handlers.ts. Registrasi baru menimpa yang lama. */
export function registerRpcHandlerDeps(deps: RpcHandlerDeps | null): void {
  rpcDeps = deps;
}

function requireRpcDeps(): RpcHandlerDeps {
  if (!rpcDeps) {
    throw new Error("rpc handler deps belum ter-wiring (registerRpcHandlerDeps belum dipanggil dari main.ts)");
  }
  return rpcDeps;
}

/**
 * Registry koneksi cc-stub: bot_id -> socket IPC yang mendaftar via
 * `session.register`. Modul-scoped karena hostd berjalan sebagai satu proses
 * daemon per pipe; satu bot_id hanya boleh punya satu koneksi aktif pada satu
 * waktu (registrasi baru menimpa yang lama).
 */
const connections = new Map<string, net.Socket>();

const SessionRegisterParams = z.object({ bot_id: z.string().min(1) }).strict();

const handlers: Record<string, Handler> = {
  doctor: () =>
    doctorReport(
      rpcDeps
        ? {
            db: rpcDeps.db,
            adapterStatuses: rpcDeps.adapterStatuses,
            deliveryStats: rpcDeps.deliveryStats?.(),
            supervisorStatuses: rpcDeps.supervisorStatuses?.(),
          }
        : {},
    ),
  "session.register": (params, sock) => {
    const { bot_id } = SessionRegisterParams.parse(params);
    connections.set(bot_id, sock);
    sock.once("close", () => {
      // Hanya hapus bila socket ini masih pemegang mapping (bisa saja sudah
      // ditimpa oleh registrasi bot_id yang sama dari koneksi baru).
      if (connections.get(bot_id) === sock) connections.delete(bot_id);
    });
    return { registered: true, bot_id };
  },
  "channel.confirm": params => {
    const { envelope_id, attempt_token } = ChannelConfirmParams.parse(params);
    if (!confirmDelegate) {
      // Kegagalan harus terlihat (prinsip §2.5): tanpa wiring, jangan diam2 "sukses".
      throw new Error("channel.confirm: belum ter-wiring (registerConfirmHandler belum dipanggil)");
    }
    return confirmDelegate(envelope_id, attempt_token);
  },
  // Task D2 — cc-stub tools proxy. Semua 4 method di bawah delegasi murni ke
  // rpc-handlers.ts lewat `rpcDeps` (di-inject main.ts); tanpa wiring, error
  // terlihat (requireRpcDeps), bukan diam-diam sukses/kosong.
  "telegram.outbound": params => handleTelegramOutbound(params, requireRpcDeps()),
  "agent.list": params => handleAgentList(params, requireRpcDeps()),
  "agent.status": params => handleAgentStatus(params, requireRpcDeps()),
  "agent.send": params => handleAgentSend(params, requireRpcDeps()),
};

/** Apakah bot_id punya koneksi cc-stub terdaftar saat ini. */
export function isRegistered(botId: string): boolean {
  return connections.has(botId);
}

/**
 * Hancurkan paksa semua koneksi cc-stub yang terdaftar. Dipanggil dari
 * main.ts's `shutdown()` SEBELUM `server.close()` — `net.Server#close()`
 * hanya memanggil callback-nya setelah SEMUA koneksi terbuka berakhir
 * sendiri; satu cc-stub yang masih terhubung (tidak pernah `.end()`)
 * membuat shutdown menggantung selamanya (process.exit tak pernah
 * terpanggil). `.destroy()` (bukan `.end()`) memutus segera tanpa menunggu
 * sisi lain merespons, memicu event `close` milik masing-masing socket
 * (yang sudah membersihkan entrinya sendiri dari `connections` — lihat
 * `session.register` di atas), jadi tidak perlu membersihkan map ini secara
 * manual di sini.
 */
export function destroyAllConnections(): void {
  for (const sock of connections.values()) {
    sock.destroy();
  }
}

/**
 * Kirim event JSON-RPC (notification, tanpa id) `method`/`params` ke koneksi
 * cc-stub terdaftar untuk `botId`. Return `false` (tanpa melempar) bila tak
 * ada koneksi terdaftar atau write ke socket gagal — pemanggil (delivery.ts)
 * bertanggung jawab menangani ini sbg kegagalan terlihat (fail + retry),
 * bukan drop senyap atau ack envelope yang gagal terkirim (SCAR-056).
 */
export function pushEvent(botId: string, method: string, params: unknown): boolean {
  const sock = connections.get(botId);
  if (!sock) return false;
  const event: RpcEventT = { jsonrpc: "2.0", method, params };
  return sock.write(JSON.stringify(event) + "\n");
}

function respond(sock: net.Socket, obj: object): void {
  sock.write(JSON.stringify(obj) + "\n");
}

/**
 * `async` sejak Task D2: `telegram.outbound` mendelegasikan ke
 * `OutboundSender.handle()` yang mengirim lewat Telegram Bot API (I/O nyata,
 * bukan sync). Handler lama (doctor/session.register/channel.confirm) tetap
 * sync — `await` di bawah transparan menerima keduanya (nilai biasa atau
 * Promise). Catatan: ini melonggarkan urutan balasan bila beberapa request
 * datang dalam satu chunk TCP dan salah satu handler async lebih lambat dari
 * yang lain (bisa saja balasan tiba tidak dalam urutan kirim) — dampaknya
 * dianggap dapat diterima di fase ini (satu koneksi cc-stub praktiknya
 * memanggil satu tool pada satu waktu, menunggu balasannya sebelum
 * memanggil lagi; lihat ipc-client.ts's per-`id` correlation yang sudah
 * menangani out-of-order response dgn benar).
 */
async function handleLine(sock: net.Socket, line: string): Promise<void> {
  let id: string | number | null = null;
  try {
    const msg = parseRpcMessage(line);
    const req = RpcRequest.safeParse(msg);
    if (!req.success) {
      respond(sock, { jsonrpc: "2.0", id, error: { code: -32600, message: "bukan request" } });
      return;
    }
    id = req.data.id;
    const handler = handlers[req.data.method];
    if (!handler) {
      respond(sock, { jsonrpc: "2.0", id, error: { code: -32601, message: `method tak dikenal: ${req.data.method}` } });
      return;
    }
    const result = await handler(req.data.params, sock);
    respond(sock, { jsonrpc: "2.0", id, result });
  } catch (e) {
    // Prinsip §2.5: kegagalan harus terlihat — balas error, jangan telan.
    respond(sock, { jsonrpc: "2.0", id, error: { code: -32700, message: String(e) } });
  }
}

export function startServer(pipeName: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(sock => {
      let buf = "";
      sock.on("data", d => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) void handleLine(sock, line);
        }
      });
      sock.on("error", err => console.error(`[hostd] socket error: ${err.message}`));
    });
    server.on("error", reject);
    server.listen(pipeName, () => resolve(server));
  });
}
