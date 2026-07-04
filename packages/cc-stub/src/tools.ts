import { basename } from "node:path";
import {
  REACT_TOOL_DESCRIPTION,
  REPLY_TOOL_DESCRIPTION,
  DOWNLOAD_ATTACHMENT_TOOL_DESCRIPTION,
  GET_MESSAGE_BY_ID_TOOL_DESCRIPTION,
  AGENT_LIST_TOOL_DESCRIPTION,
  AGENT_STATUS_TOOL_DESCRIPTION,
  AGENT_SEND_TOOL_DESCRIPTION,
  ReplyToolJsonSchema,
  ReactToolJsonSchema,
  DownloadAttachmentToolJsonSchema,
  GetMessageByIdToolJsonSchema,
  AgentListToolJsonSchema,
  AgentStatusToolJsonSchema,
  AgentSendToolJsonSchema,
} from "@mirza-harness/shared";

/**
 * Task D2, Fase 1 — cc-stub tools proxy (7 MCP tools: reply/react/
 * download_attachment/get_message_by_id from `plugins/telegram/server.ts:572-654`,
 * agent_list/agent_status/agent_send from `plugins/agent-bus/server.ts:56-108`).
 *
 * EVERY handler here is a thin proxy: `deps.call(method, params)` to hostd
 * over the existing IPC pipe (ipc-client.ts). There is NO business logic —
 * no validation beyond picking which raw args go into which RPC params
 * field, no decisions, no state. hostd's `rpc-handlers.ts` is the single
 * place that runs zod `.parse()` on these params and does the real work
 * (telegram send, bus enqueue, config lookups). A bad shape or a refused
 * request simply comes back as an RPC error, which this module turns into a
 * `{isError: true}` tool result — never swallowed, never guessed at.
 *
 * `inputSchema` for each tool is NOT hand-maintained here: it's imported
 * pre-generated from `@mirza-harness/shared`'s `rpc.ts` (one zod source,
 * `zodToJsonSchema` conversion — see json-schema.ts), so the tool surface
 * shown to the AI and the RPC params hostd validates can never silently
 * drift apart.
 */

// ---------------------------------------------------------------------------
// bot_id resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve this stub's own bot_id: `MIRZA_BOT_ID` env var if set (trimmed,
 * non-empty), else the basename of the current working directory (each bot's
 * mirza-cc wrapper runs cc-stub with cwd = that bot's workspace dir, so the
 * folder name is a reasonable fallback identity — e.g. `C:/.../bot-03` ->
 * `"bot-03"`). Documented here rather than hard-failing (unlike the module's
 * previous behavior of `process.exit(1)` when the env var was absent) —
 * MIRZA_BOT_ID is still the recommended, unambiguous way to set identity;
 * the fallback exists so a manually-launched stub in a sanely-named
 * workspace dir still works.
 */
export function resolveBotId(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const fromEnv = env.MIRZA_BOT_ID?.trim();
  if (fromEnv) return fromEnv;
  return basename(cwd);
}

// ---------------------------------------------------------------------------
// Tool listing.
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_DEFINITIONS: McpToolDefinition[] = [
  { name: "reply", description: REPLY_TOOL_DESCRIPTION, inputSchema: ReplyToolJsonSchema },
  { name: "react", description: REACT_TOOL_DESCRIPTION, inputSchema: ReactToolJsonSchema },
  { name: "download_attachment", description: DOWNLOAD_ATTACHMENT_TOOL_DESCRIPTION, inputSchema: DownloadAttachmentToolJsonSchema },
  { name: "get_message_by_id", description: GET_MESSAGE_BY_ID_TOOL_DESCRIPTION, inputSchema: GetMessageByIdToolJsonSchema },
  { name: "agent_list", description: AGENT_LIST_TOOL_DESCRIPTION, inputSchema: AgentListToolJsonSchema },
  { name: "agent_status", description: AGENT_STATUS_TOOL_DESCRIPTION, inputSchema: AgentStatusToolJsonSchema },
  { name: "agent_send", description: AGENT_SEND_TOOL_DESCRIPTION, inputSchema: AgentSendToolJsonSchema },
];

export function listToolDefinitions(): McpToolDefinition[] {
  return TOOL_DEFINITIONS;
}

// ---------------------------------------------------------------------------
// Tool call dispatch.
// ---------------------------------------------------------------------------

export interface ToolCallDeps {
  /** `HostdClient.call` (ipc-client.ts) — rejects with a clear message when hostd is unreachable/times out. */
  call: (method: string, params?: unknown) => Promise<unknown>;
  /** This stub's own bot_id (see `resolveBotId`). Used for the telegram bot_id and as agent_send's `from`. */
  botId: string;
}

export interface ToolResultContent {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolResultContent[];
  isError?: boolean;
  // Index signature so this satisfies the MCP SDK's `ServerResult` shape
  // (an object with a string index signature) when returned from a
  // `CallToolRequestSchema` handler — see server.ts's `McpToolRegistrar`.
  [key: string]: unknown;
}

function textResult(text: string): ToolCallResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resultToText(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

/**
 * The four telegram commands share one RPC method (`telegram.outbound`,
 * params `{bot_id, cmd}`) — `cmd` is the raw tool args plus the `op`
 * discriminant that names which command this is (mirrors
 * `OutboundCommandSchema` in shared/outbound-command.ts, which hostd's
 * `telegram.outbound` handler parses).
 */
const TELEGRAM_OPS = new Set(["reply", "react", "download_attachment", "get_message_by_id"]);

/**
 * Build the RPC method + params for a given tool call. Pure mapping, no
 * validation — hostd validates. Returns `null` for an unknown tool name.
 */
export function buildRpcCall(
  toolName: string,
  args: Record<string, unknown>,
  botId: string,
): { method: string; params: unknown } | null {
  if (TELEGRAM_OPS.has(toolName)) {
    return { method: "telegram.outbound", params: { bot_id: botId, cmd: { op: toolName, ...args } } };
  }
  switch (toolName) {
    case "agent_list":
      return { method: "agent.list", params: undefined };
    case "agent_status":
      return { method: "agent.status", params: args };
    case "agent_send":
      // `from` is ALWAYS this stub's own identity — never taken from `args`
      // (AgentSendToolInput, the MCP-facing schema, doesn't even accept a
      // `from` field; see rpc.ts). A caller cannot spoof another bot.
      return { method: "agent.send", params: { ...args, from: botId } };
    default:
      return null;
  }
}

export function makeCallToolHandler(deps: ToolCallDeps): (toolName: string, args: unknown) => Promise<ToolCallResult> {
  return async function handleCallTool(toolName: string, args: unknown): Promise<ToolCallResult> {
    const rpc = buildRpcCall(toolName, (args ?? {}) as Record<string, unknown>, deps.botId);
    if (!rpc) {
      return errorResult(`tool tak dikenal: ${toolName}`);
    }
    try {
      const result = await deps.call(rpc.method, rpc.params);
      return textResult(resultToText(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Kegagalan harus terlihat (prinsip §2.5) — mis. "hostd unreachable"
      // dari ipc-client.ts saat koneksi putus, atau pesan error validasi zod
      // dari hostd's rpc-handlers.ts. Diteruskan apa adanya, dibungkus jelas.
      return errorResult(`tool "${toolName}" gagal: ${msg}`);
    }
  };
}
