import net from "node:net";
import {
  PIPE_NAME_DEFAULT,
  RpcRequest,
  parseRpcMessage,
  type RpcRequestT,
  type RpcMessageT,
} from "@mirza-harness/shared";

/** Backoff basis (ms) sebelum percobaan reconnect pertama; dobel tiap gagal, cap 30s. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
/** Batas waktu (ms) menunggu balasan sebuah `call()`. */
const CALL_TIMEOUT_MS = 10_000;

export type HostdStatus =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "disconnected"; reason: string }
  | { kind: "reconnecting"; attempt: number; delayMs: number };

export interface ConnectHostdOptions {
  /** Nama named pipe hostd. Default `PIPE_NAME_DEFAULT` (`\\.\pipe\mirza-hostd`). */
  pipeName?: string;
  /** bot_id yang dikirim lewat `session.register` setiap kali (re-)connect. */
  botId: string;
  /** Event masuk dari hostd (RpcEvent tanpa id) — mis. `channel.deliver`. */
  onEvent: (method: string, params: unknown) => void;
  /** Perubahan status koneksi (opsional, utk logging/observability). */
  onStatus?: (status: HostdStatus) => void;
}

export interface HostdClient {
  /**
   * Kirim request `method`/`params` ber-id dan tunggu balasannya (result
   * atau error). Reject dgn pesan "hostd unreachable" bila tak ada koneksi
   * aktif saat ini (bukan silent-drop — pemanggil di sisi cc-stub
   * bertanggung jawab menandai kegagalan ini terlihat, mis. sbg tool error).
   * Reject dgn timeout bila tak ada balasan dalam 10 detik.
   */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Tutup koneksi rapi; hentikan reconnect loop. Idempotent. */
  close(): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  const maybeUnref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof maybeUnref === "function") maybeUnref.call(timer);
}

/**
 * Client IPC ke hostd lewat named pipe: connect, kirim `session.register
 * {bot_id}` di setiap (re-)koneksi, teruskan event masuk (RpcEvent tanpa id)
 * ke `onEvent`, dan sediakan `call()` request/response ber-id dgn timeout.
 * Putus (close/error) -> reconnect dgn backoff eksponensial (basis 1s, x2,
 * cap 30s) lalu re-register otomatis begitu tersambung lagi.
 */
export function connectHostd(opts: ConnectHostdOptions): HostdClient {
  const pipeName = opts.pipeName ?? PIPE_NAME_DEFAULT;
  let sock: net.Socket | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let buf = "";
  let nextId = 1;
  const pending = new Map<string | number, PendingCall>();

  function failAllPending(err: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  }

  function handleLine(line: string): void {
    let msg: RpcMessageT;
    try {
      msg = parseRpcMessage(line);
    } catch {
      // Baris tak valid dari hostd — abaikan (protokol NDJSON: baris lain tetap diproses).
      return;
    }
    if ("method" in msg) {
      // RpcEvent: notification searah, tanpa id.
      opts.onEvent(msg.method, msg.params);
      return;
    }
    // RpcSuccess | RpcFailure — punya id, cari pending call yg berkorelasi.
    const entry = pending.get(msg.id);
    if (!entry) return; // balasan utk call yg sudah timeout/tak dikenal — abaikan.
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if ("error" in msg) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  function call(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!sock || sock.destroyed) {
        reject(new Error("hostd unreachable"));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout menunggu balasan '${method}' dari hostd`));
      }, CALL_TIMEOUT_MS);
      unref(timer);
      pending.set(id, { resolve, reject, timer });
      const req: RpcRequestT = RpcRequest.parse({ jsonrpc: "2.0", id, method, params });
      sock.write(JSON.stringify(req) + "\n");
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** reconnectAttempt, BACKOFF_CAP_MS);
    reconnectAttempt++;
    opts.onStatus?.({ kind: "reconnecting", attempt: reconnectAttempt, delayMs });
    reconnectTimer = setTimeout(() => connect(), delayMs);
    unref(reconnectTimer);
  }

  function connect(): void {
    if (closed) return;
    buf = "";
    opts.onStatus?.({ kind: "connecting" });
    const s = net.connect(pipeName);
    sock = s;

    s.on("connect", () => {
      reconnectAttempt = 0;
      opts.onStatus?.({ kind: "connected" });
      call("session.register", { bot_id: opts.botId }).catch(err => {
        opts.onStatus?.({ kind: "disconnected", reason: `session.register gagal: ${err.message}` });
      });
    });

    s.on("data", d => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleLine(line);
      }
    });

    s.on("error", err => {
      opts.onStatus?.({ kind: "disconnected", reason: err.message });
    });

    s.on("close", () => {
      if (sock === s) sock = null;
      failAllPending(new Error("hostd unreachable"));
      if (!closed) {
        opts.onStatus?.({ kind: "disconnected", reason: "koneksi ke hostd tertutup" });
        scheduleReconnect();
      }
    });
  }

  connect();

  return {
    call,
    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      failAllPending(new Error("client ditutup"));
      sock?.destroy();
      sock = null;
    },
  };
}
