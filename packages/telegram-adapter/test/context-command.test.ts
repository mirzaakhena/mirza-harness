import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderContextReply,
  buildContextReply,
  createRpcSessionQuery,
  progressBar,
  formatRelativeMs,
  shortSession,
  renderVersionReply,
  buildVersionReply,
  readPackageVersion,
  createPackageJsonVersionQuery,
  type SessionSnapshot,
  type SessionQuery,
} from "../src/context-command";

function fullSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: "sess-1234567890",
    name: "my-session",
    lifecycle: "idle",
    started_at: 1000,
    ended_at: null,
    used_percentage: 42,
    context_window_size: 200000,
    model: "claude-sonnet-5",
    effort: "high",
    cost: 1.23,
    captured_at_ms: 5000,
    ...overrides,
  };
}

describe("progressBar / formatRelativeMs / shortSession (ported from context-renderer.ts)", () => {
  test("progressBar fills proportionally to pct", () => {
    expect(progressBar(0)).toBe("○○○○○○○○○○");
    expect(progressBar(100)).toBe("●●●●●●●●●●");
    expect(progressBar(50)).toBe("●●●●●○○○○○");
  });

  test("formatRelativeMs renders seconds/minutes/hours", () => {
    expect(formatRelativeMs(5000)).toBe("5s ago");
    expect(formatRelativeMs(65_000)).toBe("1m ago");
    expect(formatRelativeMs(3_665_000)).toBe("1h 1m ago");
  });

  test("shortSession truncates to 8 chars", () => {
    expect(shortSession("sess-1234567890")).toBe("sess-123");
  });
});

describe("renderContextReply — FUNC-1: null telemetry never crashes, always '(no data yet)'", () => {
  test("session is null (no sessions row at all yet) -> '(no data yet)', no throw", () => {
    expect(() => renderContextReply(null)).not.toThrow();
    expect(renderContextReply(null)).toBe("(no data yet)");
  });

  test("session exists but statusline never fired (all telemetry columns null) -> renders '(no data yet)' placeholders, no throw", () => {
    const session = fullSession({
      used_percentage: null,
      context_window_size: null,
      model: null,
      effort: null,
      cost: null,
      captured_at_ms: null,
    });
    expect(() => renderContextReply(session)).not.toThrow();
    const text = renderContextReply(session);
    expect(text).toContain("(no data yet)");
    // Context section itself must say so, not crash trying to read pct.
    expect(text).toMatch(/Context\n\(no data yet\)/);
    expect(text).toContain("Last update: (no data yet)");
    expect(text).toContain("Cost: (no data yet)");
    expect(text).toContain("Effort: (no data yet)");
    // Session identity (not telemetry) still renders — it's not ALL missing.
    expect(text).toContain("Session: my-session (sess-123)");
    expect(text).toContain("Lifecycle: idle");
  });

  test("session with full telemetry -> renders used%% / model / effort / cost", () => {
    const session = fullSession();
    const text = renderContextReply(session, 5500);
    expect(text).toContain("42%");
    expect(text).toContain("claude-sonnet-5");
    expect(text).toContain("Effort: high");
    expect(text).toContain("Cost: $1.23");
    expect(text).toContain("Session: my-session (sess-123)");
    expect(text).toMatch(/Last update: .+ago/);
  });

  test("Last update reflects nowMs - captured_at_ms", () => {
    const session = fullSession({ captured_at_ms: 1000 });
    const text = renderContextReply(session, 6000);
    expect(text).toContain("Last update: 5s ago");
  });

  test("partial telemetry (used_percentage present, model missing) -> no crash, mixed placeholders", () => {
    const session = fullSession({ model: null, effort: null });
    const text = renderContextReply(session);
    expect(text).toContain("42%");
    expect(text).toContain("(no data yet)"); // for model
    expect(text).toContain("Effort: (no data yet)");
  });
});

describe("buildContextReply / createRpcSessionQuery — deps injectable", () => {
  test("production shape: getSession resolves via injected call('agent.status', {name})", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const query: SessionQuery = createRpcSessionQuery(async (method, params) => {
      calls.push({ method, params });
      return { session: fullSession() };
    });

    const reply = await buildContextReply("bot-03", query, 5500);

    expect(calls).toEqual([{ method: "agent.status", params: { name: "bot-03" } }]);
    expect(reply).toContain("42%");
  });

  test("agent.status returns session:null (no sessions row yet) -> '(no data yet)', not a crash", async () => {
    const query: SessionQuery = createRpcSessionQuery(async () => ({ session: null }));
    const reply = await buildContextReply("bot-03", query);
    expect(reply).toBe("(no data yet)");
  });

  test("test fake SessionQuery (no RPC involved) -> renders normally", async () => {
    const fake: SessionQuery = { getSession: async () => fullSession({ used_percentage: 10 }) };
    const reply = await buildContextReply("bot-03", fake, 5000);
    expect(reply).toContain("10%");
  });
});

describe("renderVersionReply / buildVersionReply — VER-1: never hardcoded, injectable", () => {
  test("both versions known", () => {
    expect(renderVersionReply({ hostd: "0.0.1", holder: "0.0.1" })).toBe("Version\nhostd: 0.0.1\npty-holder: 0.0.1");
  });

  test("missing version -> '(unknown)', not a crash", () => {
    expect(renderVersionReply({ hostd: null, holder: null })).toBe("Version\nhostd: (unknown)\npty-holder: (unknown)");
  });

  test("buildVersionReply resolves via injected deps (sync or async getVersions)", async () => {
    const reply = await buildVersionReply({ getVersions: () => ({ hostd: "1.2.3", holder: "4.5.6" }) });
    expect(reply).toBe("Version\nhostd: 1.2.3\npty-holder: 4.5.6");

    const asyncReply = await buildVersionReply({ getVersions: async () => ({ hostd: "9.9.9", holder: null }) });
    expect(asyncReply).toBe("Version\nhostd: 9.9.9\npty-holder: (unknown)");
  });
});

describe("readPackageVersion / createPackageJsonVersionQuery — real fs reads", () => {
  function tmpDir(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  test("reads version field from a real package.json", () => {
    const dir = tmpDir("ctx-cmd-pkg-");
    try {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ name: "@mirza-harness/hostd", version: "0.0.7" }));
      expect(readPackageVersion(pkgPath)).toBe("0.0.7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file -> null, not a throw", () => {
    expect(() => readPackageVersion(join(tmpdir(), "does-not-exist-package.json"))).not.toThrow();
    expect(readPackageVersion(join(tmpdir(), "does-not-exist-package.json"))).toBeNull();
  });

  test("invalid JSON -> null, not a throw", () => {
    const dir = tmpDir("ctx-cmd-pkg-badjson-");
    try {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, "not json{{{");
      expect(readPackageVersion(pkgPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("version field missing/non-string -> null", () => {
    const dir = tmpDir("ctx-cmd-pkg-noversion-");
    try {
      const pkgPath = join(dir, "package.json");
      writeFileSync(pkgPath, JSON.stringify({ name: "x", version: 123 }));
      expect(readPackageVersion(pkgPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createPackageJsonVersionQuery reads both real package.json files (hostd + pty-holder from this monorepo)", () => {
    const hostdPkgJson = join(import.meta.dir, "..", "..", "hostd", "package.json");
    const holderPkgJson = join(import.meta.dir, "..", "..", "pty-holder", "package.json");
    const query = createPackageJsonVersionQuery({ hostdPkgJson, holderPkgJson });
    const versions = query.getVersions() as { hostd: string | null; holder: string | null };
    expect(versions.hostd).toBe("0.0.1");
    expect(versions.holder).toBe("0.0.1");
  });
});
