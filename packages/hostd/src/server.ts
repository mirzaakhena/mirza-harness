import net from "node:net";
import { RpcRequest, parseRpcMessage } from "@mirza-harness/shared";
import { doctorReport } from "./doctor";

type Handler = (params: unknown) => unknown;

const handlers: Record<string, Handler> = {
  doctor: () => doctorReport(),
};

function respond(sock: net.Socket, obj: object): void {
  sock.write(JSON.stringify(obj) + "\n");
}

function handleLine(sock: net.Socket, line: string): void {
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
    respond(sock, { jsonrpc: "2.0", id, result: handler(req.data.params) });
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
          if (line) handleLine(sock, line);
        }
      });
      sock.on("error", err => console.error(`[hostd] socket error: ${err.message}`));
    });
    server.on("error", reject);
    server.listen(pipeName, () => resolve(server));
  });
}
