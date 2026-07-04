import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { zodToJsonSchema } from "../src/json-schema";
import { ReplyToolJsonSchema, AgentSendToolJsonSchema } from "../src/rpc";

describe("zodToJsonSchema", () => {
  test("string/number/boolean primitives", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  test("description carried through on the node it's attached to", () => {
    expect(zodToJsonSchema(z.string().describe("a thing"))).toEqual({ type: "string", description: "a thing" });
  });

  test("optional unwraps to inner type; description on the optional wrapper wins", () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({ type: "string" });
    expect(zodToJsonSchema(z.string().optional().describe("outer"))).toEqual({ type: "string", description: "outer" });
  });

  test("literal -> single-value enum", () => {
    expect(zodToJsonSchema(z.literal("prompt"))).toEqual({ type: "string", enum: ["prompt"] });
  });

  test("enum -> string enum", () => {
    expect(zodToJsonSchema(z.enum(["a", "b", "c"]))).toEqual({ type: "string", enum: ["a", "b", "c"] });
  });

  test("array -> items", () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({ type: "array", items: { type: "string" } });
  });

  test("union -> oneOf", () => {
    expect(zodToJsonSchema(z.union([z.string(), z.array(z.string())]))).toEqual({
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    });
  });

  test("object -> properties + required (optional fields excluded from required)", () => {
    const schema = z
      .object({
        a: z.string(),
        b: z.number().optional(),
      })
      .strict();
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
  });

  test("empty object -> no required key", () => {
    expect(zodToJsonSchema(z.object({}).strict())).toEqual({ type: "object", properties: {} });
  });

  test("unsupported construct degrades to opaque {} rather than throwing", () => {
    expect(zodToJsonSchema(z.record(z.string()))).toEqual({});
  });

  test("ZodEffects (.refine()) unwraps to the inner schema instead of degrading to opaque {}", () => {
    const schema = z.object({ x: z.number() }).strict().refine((v) => v.x > 0, { message: "x must be positive" });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
    });
  });

  test("ZodEffects description precedence: wrapper's own .describe() wins over inner schema's description", () => {
    const withOuterOnly = z.string().refine((s) => s.length > 0);
    expect(zodToJsonSchema(withOuterOnly)).toEqual({ type: "string" });

    const withInnerDescription = z.string().describe("inner").refine((s) => s.length > 0);
    expect(zodToJsonSchema(withInnerDescription)).toEqual({ type: "string", description: "inner" });

    const withBothDescriptions = z.string().describe("inner").refine((s) => s.length > 0).describe("outer");
    expect(zodToJsonSchema(withBothDescriptions)).toEqual({ type: "string", description: "outer" });
  });

  test("real MCP tool schemas: reply's buttons is array-of-array-of-{label,callback_id} (not opaque {})", () => {
    const buttons = ReplyToolJsonSchema.properties as Record<string, any>;
    const buttonsField = buttons.buttons;
    expect(buttonsField.type).toBe("array");
    expect(buttonsField.items.type).toBe("array");
    expect(buttonsField.items.items.properties.label).toBeDefined();
    expect(buttonsField.items.items.properties.label.type).toBe("string");
    expect(buttonsField.items.items.properties.callback_id).toBeDefined();
    expect(buttonsField.items.items.properties.callback_id.type).toBe("string");
  });

  test("real MCP tool schemas: agent_send's payload.body is a string field (not opaque {})", () => {
    const properties = AgentSendToolJsonSchema.properties as Record<string, any>;
    const payload = properties.payload;
    expect(payload.properties.body.type).toBe("string");
  });
});
