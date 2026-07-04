import { describe, expect, test } from "bun:test";
import { parseLegacyPending } from "../src/legacy-pending";

describe("parseLegacyPending — command (single)", () => {
  test("minimal {id,ts,command} parses", () => {
    const r = parseLegacyPending({ id: "c1", ts: "2026-07-05T00:00:00.000Z", command: "/clear" });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "command") {
      expect(r.payload.command).toBe("/clear");
      expect(r.payload.id).toBe("c1");
    } else {
      throw new Error("expected kind=command");
    }
  });

  test("legacy sessionName/confirmAfterMs extras don't get rejected", () => {
    const r = parseLegacyPending({
      id: "c2",
      ts: "2026-07-05T00:00:00.000Z",
      command: "/effort",
      confirmAfterMs: 500,
    });
    expect(r.ok).toBe(true);
  });

  test("command missing leading slash is rejected", () => {
    const r = parseLegacyPending({ id: "c3", ts: "x", command: "clear" });
    expect(r.ok).toBe(false);
  });

  test("unknown extra key is rejected (strict)", () => {
    const r = parseLegacyPending({ id: "c4", ts: "x", command: "/clear", bogus: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("parseLegacyPending — batch (array root)", () => {
  test("ordered batch of command items parses", () => {
    const r = parseLegacyPending([{ command: "/clear" }, { command: "/rename foo" }]);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "batch") {
      expect(r.items.map(i => i.command)).toEqual(["/clear", "/rename foo"]);
    } else {
      throw new Error("expected kind=batch");
    }
  });

  test("empty array is rejected", () => {
    expect(parseLegacyPending([]).ok).toBe(false);
  });

  test("batch item without leading slash is rejected", () => {
    expect(parseLegacyPending([{ command: "oops" }]).ok).toBe(false);
  });
});

describe("parseLegacyPending — prompt (agent-bus)", () => {
  test("full prompt payload parses", () => {
    const r = parseLegacyPending({
      id: "p1",
      ts: "2026-07-05T00:00:00.000Z",
      type: "prompt",
      from: "bot-01",
      text: "[Message from agent bot-01 ...] halo",
      hop_count: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "prompt") {
      expect(r.payload.from).toBe("bot-01");
      expect(r.payload.hop_count).toBe(1);
    } else {
      throw new Error("expected kind=prompt");
    }
  });

  test("hop_count defaults to 0 when omitted", () => {
    const r = parseLegacyPending({
      id: "p2",
      ts: "2026-07-05T00:00:00.000Z",
      type: "prompt",
      from: "bot-01",
      text: "halo",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "prompt") expect(r.payload.hop_count).toBe(0);
  });

  test("prompt missing text is rejected", () => {
    const r = parseLegacyPending({ id: "p3", ts: "x", type: "prompt", from: "bot-01" });
    expect(r.ok).toBe(false);
  });
});

describe("parseLegacyPending — malformed / unsupported root shapes", () => {
  test("null is rejected", () => {
    expect(parseLegacyPending(null).ok).toBe(false);
  });

  test("string is rejected", () => {
    expect(parseLegacyPending("not an object").ok).toBe(false);
  });

  test("switch payload (not yet implemented this phase) is rejected", () => {
    const r = parseLegacyPending({ id: "s1", ts: "x", type: "switch", sessionId: "abc" });
    expect(r.ok).toBe(false);
  });
});
