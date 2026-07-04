import { describe, expect, test } from "bun:test";
import { InjectParams, InjectSlashParams, ResizeParams, makeError, makeEvent, makeResult, writeLine } from "../src/ipc";

describe("InjectParams", () => {
  test("accepts a valid inject request", () => {
    const parsed = InjectParams.safeParse({ id: "a1", text: "hello", submit: true });
    expect(parsed.success).toBe(true);
  });

  test("rejects a missing required field", () => {
    expect(InjectParams.safeParse({ id: "a1", text: "hello" }).success).toBe(false);
  });

  test("rejects an empty id", () => {
    expect(InjectParams.safeParse({ id: "", text: "hello", submit: true }).success).toBe(false);
  });

  test("rejects unknown extra keys (strict)", () => {
    expect(InjectParams.safeParse({ id: "a1", text: "hi", submit: false, extra: 1 }).success).toBe(false);
  });
});

describe("InjectSlashParams", () => {
  test("accepts a request without confirmAfterMs", () => {
    expect(InjectSlashParams.safeParse({ id: "a1", command: "/clear" }).success).toBe(true);
  });

  test("accepts a request with confirmAfterMs", () => {
    expect(InjectSlashParams.safeParse({ id: "a1", command: "/clear", confirmAfterMs: 500 }).success).toBe(true);
  });

  test("rejects an empty command", () => {
    expect(InjectSlashParams.safeParse({ id: "a1", command: "" }).success).toBe(false);
  });

  test("rejects unknown extra keys (strict)", () => {
    expect(InjectSlashParams.safeParse({ id: "a1", command: "/x", bogus: true }).success).toBe(false);
  });
});

describe("ResizeParams", () => {
  test("accepts positive integer cols/rows", () => {
    expect(ResizeParams.safeParse({ cols: 100, rows: 30 }).success).toBe(true);
  });

  test("rejects zero/negative/non-integer values", () => {
    expect(ResizeParams.safeParse({ cols: 0, rows: 30 }).success).toBe(false);
    expect(ResizeParams.safeParse({ cols: -1, rows: 30 }).success).toBe(false);
    expect(ResizeParams.safeParse({ cols: 100.5, rows: 30 }).success).toBe(false);
  });
});

describe("writeLine / makeEvent / makeResult / makeError", () => {
  function captureWrites(): { calls: string[]; stream: { write: (s: string) => boolean } } {
    const calls: string[] = [];
    return { calls, stream: { write: (s: string) => (calls.push(s), true) } };
  }

  test("writeLine JSON-serializes with a trailing newline", () => {
    const { calls, stream } = captureWrites();
    writeLine(stream as unknown as NodeJS.WritableStream, { a: 1 });
    expect(calls).toEqual(['{"a":1}\n']);
  });

  test("makeEvent builds a valid no-id RpcEvent envelope", () => {
    expect(makeEvent("injected", { id: "x1" })).toEqual({ jsonrpc: "2.0", method: "injected", params: { id: "x1" } });
  });

  test("makeResult builds a success envelope carrying the request id", () => {
    expect(makeResult(7, { queued: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { queued: true } });
  });

  test("makeError builds a failure envelope carrying the request id", () => {
    expect(makeError("id-1", -32602, "bad params")).toEqual({
      jsonrpc: "2.0",
      id: "id-1",
      error: { code: -32602, message: "bad params" },
    });
  });
});
