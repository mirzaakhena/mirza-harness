import { z } from "zod";

/**
 * Minimal, purpose-built zod -> JSON Schema converter — NOT a general-purpose
 * library (no external `zod-to-json-schema` dependency was added; Task D2
 * constraint: avoid new deps unless truly needed). Supports exactly the zod
 * constructs used by the MCP tool input schemas in `rpc.ts`: string, number,
 * boolean, literal, enum, array, union, object, optional. Anything else
 * degrades to `{}` (opaque) rather than throwing — good enough for a
 * best-effort `inputSchema` shown to the calling AI; the REAL validation
 * always happens via the zod schema itself (`.parse()`/`.safeParse()`), never
 * via this derived JSON Schema.
 */

export type JsonSchema = Record<string, unknown>;

function withDescription(node: JsonSchema, description: string | undefined): JsonSchema {
  return description ? { ...node, description } : node;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodOptional) {
    return withDescription(zodToJsonSchema(schema.unwrap()), schema.description);
  }
  if (schema instanceof z.ZodDefault) {
    return withDescription(zodToJsonSchema(schema.removeDefault()), schema.description);
  }
  if (schema instanceof z.ZodString) {
    return withDescription({ type: "string" }, schema.description);
  }
  if (schema instanceof z.ZodNumber) {
    return withDescription({ type: "number" }, schema.description);
  }
  if (schema instanceof z.ZodBoolean) {
    return withDescription({ type: "boolean" }, schema.description);
  }
  if (schema instanceof z.ZodLiteral) {
    const t = typeof schema.value;
    return withDescription({ type: t === "string" || t === "number" || t === "boolean" ? t : "string", enum: [schema.value] }, schema.description);
  }
  if (schema instanceof z.ZodEnum) {
    return withDescription({ type: "string", enum: schema.options }, schema.description);
  }
  if (schema instanceof z.ZodArray) {
    return withDescription({ type: "array", items: zodToJsonSchema(schema.element) }, schema.description);
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as z.ZodTypeAny[]).map((o) => zodToJsonSchema(o));
    return withDescription({ oneOf: options }, schema.description);
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    const node: JsonSchema = { type: "object", properties };
    if (required.length > 0) node.required = required;
    return withDescription(node, schema.description);
  }
  if (schema instanceof z.ZodEffects) {
    // Wrapper produced by `.refine()`/`.superRefine()` (and `.transform()`,
    // unused here) — the real shape lives on `.innerType()`, not on the
    // effects wrapper itself. Recurse into it so refined schemas (e.g.
    // `ButtonsSchema`'s `.superRefine`, `AgentSendPayloadSchema.body`'s
    // `.refine`) still produce their real JSON Schema instead of falling
    // through to the opaque `{}` fallback below. A `.describe()` called on
    // the wrapper itself (after `.refine`/`.superRefine`) takes precedence
    // over any description on the inner schema — same precedence rule as
    // the ZodOptional/ZodDefault branches above.
    return withDescription(zodToJsonSchema(schema.innerType()), schema.description);
  }
  // Fallback: construct not covered above (e.g. z.record, z.unknown) — opaque
  // but never throws, so an unexpected schema shape degrades gracefully in
  // the tool listing instead of crashing the MCP server at startup.
  return withDescription({}, schema.description);
}
