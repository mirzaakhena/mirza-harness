import { z } from "zod";
import type { RpcEventT, RpcRequestT } from "@mirza-harness/shared";

/**
 * pty-holder's parent<->child wire contract: stdio NDJSON JSON-RPC, reusing
 * `@mirza-harness/shared`'s generic `RpcRequest`/`RpcEvent` envelope
 * (jsonrpc/id/method/params) and adding this package's own `params` shapes
 * per method plus its event payload types.
 *
 * Requests (parent -> child, carry `id`, get an `RpcResponse` back):
 *  - `inject`       {id, text, submit}            — type a body, optionally submit.
 *  - `inject-slash` {id, command, confirmAfterMs?} — type+submit a slash command.
 *  - `resize`       {cols, rows}                   — propagate a terminal resize.
 *  - `shutdown`     (no params)                     — terminate the held PTY.
 *
 * Events (child -> parent, no `id`):
 *  - `pty-exit`  {code, signal} — the held process exited; the holder is about to too.
 *  - `pty-error` {message}      — the PTY failed to spawn or a write/resize threw.
 *  - `injected`  {id}           — the requested keystrokes have been WRITTEN to the
 *    PTY (ack level = "typed", not "Claude Code processed them semantically" —
 *    pty-holder has no session/name/barrier knowledge, see module docs).
 *
 * `id` on `inject`/`inject-slash` is the caller's own correlation id, echoed
 * back verbatim on the `injected` event once that request's write plan
 * finishes — it is NOT the JSON-RPC envelope id (though callers may choose
 * to reuse the same value for both).
 */

export const InjectParams = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    submit: z.boolean(),
  })
  .strict();
export type InjectParamsT = z.infer<typeof InjectParams>;

export const InjectSlashParams = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    confirmAfterMs: z.number().finite().optional(),
  })
  .strict();
export type InjectSlashParamsT = z.infer<typeof InjectSlashParams>;

export const ResizeParams = z
  .object({
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  })
  .strict();
export type ResizeParamsT = z.infer<typeof ResizeParams>;

/** `shutdown` takes no params — schema exists so callers/tests have something to `.parse(undefined)` against. */
export const ShutdownParams = z.undefined();

export interface PtyExitEvent {
  code: number;
  /** node-pty reports the exit signal as its numeric code, not a name; `null` when the process exited normally. */
  signal: number | null;
}

export interface PtyErrorEvent {
  message: string;
}

export interface InjectedEvent {
  id: string;
}

/**
 * Serialize one NDJSON message (request/response/event) and write it with a
 * trailing `\n`. `callback`, if given, is Node's normal `stream.write`
 * completion callback — fired once this chunk has actually been handed off
 * (not merely enqueued). Callers that need to guarantee a message reached
 * the parent BEFORE doing something irreversible (e.g. `process.exit()` in
 * `main.ts`'s shutdown path) should pass one and act inside it rather than
 * assuming a synchronous `stream.write()` call is enough.
 */
export function writeLine(stream: NodeJS.WritableStream, msg: unknown, callback?: (err?: Error | null) => void): void {
  stream.write(JSON.stringify(msg) + "\n", callback);
}

/** Build an `RpcEvent` envelope (jsonrpc 2.0, no id) for `writeLine`. */
export function makeEvent(method: string, params: unknown): RpcEventT {
  return { jsonrpc: "2.0", method, params };
}

/** Build a successful `RpcResponse` for a given request id. */
export function makeResult(id: RpcRequestT["id"], result: unknown): { jsonrpc: "2.0"; id: RpcRequestT["id"]; result: unknown } {
  return { jsonrpc: "2.0", id, result };
}

/** Build a failed `RpcResponse` for a given request id. */
export function makeError(
  id: RpcRequestT["id"],
  code: number,
  message: string,
): { jsonrpc: "2.0"; id: RpcRequestT["id"]; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
