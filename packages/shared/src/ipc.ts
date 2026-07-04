import { z } from "zod";

export const PIPE_NAME_DEFAULT = "\\\\.\\pipe\\mirza-hostd";

export const RpcId = z.union([z.string(), z.number()]);

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const RpcSuccess = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  result: z.unknown(),
}).strict();

export const RpcFailure = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcId,
  error: z.object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }).strict(),
}).strict();

export const RpcResponse = z.union([RpcSuccess, RpcFailure]);

// Notification/event: TANPA id (searah, tidak dijawab).
export const RpcEvent = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const RpcMessage = z.union([RpcRequest, RpcSuccess, RpcFailure, RpcEvent]);

export type RpcRequestT = z.infer<typeof RpcRequest>;
export type RpcResponseT = z.infer<typeof RpcResponse>;
export type RpcEventT = z.infer<typeof RpcEvent>;
export type RpcMessageT = z.infer<typeof RpcMessage>;

/** Parse satu baris NDJSON menjadi RpcMessage; throw bila bukan JSON atau tak cocok skema. */
export function parseRpcMessage(line: string): RpcMessageT {
  return RpcMessage.parse(JSON.parse(line));
}
