import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvelopeT } from "@mirza-harness/shared";
import {
  startPendingConsumer,
  type InjectRequest,
  type PendingConsumerHandle,
  type PendingFsOps,
  type PendingStatus,
} from "../src/shim/pending-consumer";

function tmpPendingDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mirza-hostd-pending-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonFile(dir: string, filename: string, body: unknown): void {
  fs.writeFileSync(path.join(dir, filename), typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out");
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

interface Harness {
  dir: string;
  envs: EnvelopeT[];
  injects: InjectRequest[];
  statuses: PendingStatus[];
  handle: PendingConsumerHandle;
  stop: () => void;
}

function startHarness(name: string, opts: { fsOps?: Partial<PendingFsOps>; botId?: string } = {}): Harness {
  const dir = tmpPendingDir(name);
  const envs: EnvelopeT[] = [];
  const injects: InjectRequest[] = [];
  const statuses: PendingStatus[] = [];
  const handle = startPendingConsumer({
    dir,
    botId: opts.botId ?? "bot-06",
    enqueueEnv: env => {
      envs.push(env);
      return true;
    },
    enqueueInject: req => {
      injects.push(req);
    },
    onStatus: status => {
      statuses.push(status);
    },
    deferMs: 5,
    sweepIntervalMs: 20,
    fsOps: opts.fsOps,
  });
  return { dir, envs, injects, statuses, handle, stop: handle.stop };
}

const VALID_UUID_1 = "11111111-1111-1111-1111-111111111111";
const VALID_UUID_2 = "22222222-2222-2222-2222-222222222222";

describe("pending-consumer — prompt payload", () => {
  test("valid prompt file produces a correct kind:'prompt' envelope, then deletes the file", async () => {
    const h = startHarness("prompt-valid");
    try {
      writeJsonFile(h.dir, `${VALID_UUID_1}.json`, {
        id: VALID_UUID_1,
        ts: "2026-07-05T00:00:00.000Z",
        type: "prompt",
        from: "bot-01",
        text: "[Message from agent bot-01 via agent-bus (hop 0). ...] halo dari bot lama",
        hop_count: 2,
      });

      await waitUntil(() => h.envs.length === 1);

      const env = h.envs[0]!;
      expect(env.kind).toBe("prompt");
      expect(env.to).toBe("bot-06");
      expect(env.from).toBe("bot-01");
      expect(env.id).toBe(VALID_UUID_1);
      expect(env.hop).toBe(2);
      const payload = env.payload as { content: string; meta: Record<string, unknown> };
      expect(payload.content).toBe("[Message from agent bot-01 via agent-bus (hop 0). ...] halo dari bot lama");
      expect(payload.meta.from).toBe("bot-01");

      await waitUntil(() => !fs.existsSync(path.join(h.dir, `${VALID_UUID_1}.json`)));
      expect(h.injects.length).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — hop count validation (Fix 2: command hop drop)", () => {
  test("command with from + hop_count > 5 -> dropped, not injected", async () => {
    const h = startHarness("cmd-hop-drop");
    try {
      const filename = `${VALID_UUID_1}.json`;
      writeJsonFile(h.dir, filename, {
        id: VALID_UUID_1,
        ts: "2026-07-05T00:00:00.000Z",
        command: "/clear",
        from: "bot-01",
        hop_count: 6, // exceeds MAX_HOP=5
      });

      await waitUntil(() => !fs.existsSync(path.join(h.dir, filename)));
      // File was deleted, but no injection happened
      await new Promise(r => setTimeout(r, 60));
      expect(h.injects.length).toBe(0);
      expect(h.statuses.some(s => s.message.includes("exceeds"))).toBe(true);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — command / batch payloads", () => {
  test("single command -> enqueueInject({id, commands:[cmd]})", async () => {
    const h = startHarness("cmd-single");
    try {
      writeJsonFile(h.dir, `${VALID_UUID_1}.json`, { id: VALID_UUID_1, ts: "2026-07-05T00:00:00.000Z", command: "/clear" });

      await waitUntil(() => h.injects.length === 1);
      expect(h.injects[0]).toEqual({ id: VALID_UUID_1, commands: ["/clear"] });
      await waitUntil(() => !fs.existsSync(path.join(h.dir, `${VALID_UUID_1}.json`)));
    } finally {
      h.stop();
    }
  });

  test("batch array preserves order, id falls back to filename stem", async () => {
    const h = startHarness("cmd-batch");
    try {
      writeJsonFile(h.dir, `${VALID_UUID_2}.json`, [{ command: "/foo" }, { command: "/bar" }, { command: "/baz qux" }]);

      await waitUntil(() => h.injects.length === 1);
      expect(h.injects[0]!.id).toBe(VALID_UUID_2);
      expect(h.injects[0]!.commands).toEqual(["/foo", "/bar", "/baz qux"]);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — prompt envelope validation (Fix 1: ZodError catch)", () => {
  test("prompt with invalid UUID id -> quarantined, not thrown", async () => {
    const h = startHarness("prompt-invalid-uuid");
    try {
      const filename = "bukan-uuid-123.json";
      writeJsonFile(h.dir, filename, {
        id: "bukan-uuid-123", // not a valid UUID
        ts: "2026-07-05T00:00:00.000Z",
        type: "prompt",
        from: "bot-01",
        text: "halo",
        hop_count: 0,
      });

      await waitUntil(() => fs.readdirSync(h.dir).some(f => f.startsWith(`${filename}.rejected-`)));
      expect(h.statuses.some(s => s.level === "warning" && s.message.includes("envelope schema"))).toBe(true);
      expect(h.envs.length).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — corrupt files are quarantined, never thrown", () => {
  test("invalid JSON -> renamed to <name>.rejected-<ts>, onStatus warning, no throw", async () => {
    const h = startHarness("corrupt-json");
    try {
      const filename = `${VALID_UUID_1}.json`;
      writeJsonFile(h.dir, filename, "{ this is not valid json");

      await waitUntil(() => !fs.existsSync(path.join(h.dir, filename)));
      await waitUntil(() => fs.readdirSync(h.dir).some(f => f.startsWith(`${filename}.rejected-`)));

      expect(h.statuses.some(s => s.level === "warning")).toBe(true);
      expect(h.envs.length).toBe(0);
      expect(h.injects.length).toBe(0);
    } finally {
      h.stop();
    }
  });

  test("schema-invalid payload (missing command slash) -> quarantined, not silently dropped", async () => {
    const h = startHarness("corrupt-schema");
    try {
      const filename = `${VALID_UUID_1}.json`;
      writeJsonFile(h.dir, filename, { id: VALID_UUID_1, ts: "x", command: "no-slash-here" });

      await waitUntil(() => fs.readdirSync(h.dir).some(f => f.startsWith(`${filename}.rejected-`)));
      expect(h.statuses.some(s => s.level === "warning")).toBe(true);
      expect(h.injects.length).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — idempotency by payload id (LOSS-3)", () => {
  test("a duplicate id (resent in a second file) is processed only once", async () => {
    const h = startHarness("dup-id");
    try {
      const sharedId = VALID_UUID_1;
      writeJsonFile(h.dir, "first.json", { id: sharedId, ts: "2026-07-05T00:00:00.000Z", command: "/one" });
      await waitUntil(() => h.injects.length === 1);
      await waitUntil(() => !fs.existsSync(path.join(h.dir, "first.json")));

      // Same id, different file/filename, arrives later (resend after crash-recovery, etc).
      writeJsonFile(h.dir, "second.json", { id: sharedId, ts: "2026-07-05T00:00:01.000Z", command: "/two" });
      await waitUntil(() => !fs.existsSync(path.join(h.dir, "second.json")));

      // Give a couple more sweep ticks a chance to (wrongly) re-fire before asserting.
      await new Promise(r => setTimeout(r, 60));
      expect(h.injects.length).toBe(1);
      expect(h.injects[0]!.commands).toEqual(["/one"]);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — .tmp. files are skipped", () => {
  test("a *.json.tmp.<pid> file is never read, never deleted", async () => {
    const h = startHarness("tmp-skip");
    try {
      const tmpName = `${VALID_UUID_1}.json.tmp.12345`;
      writeJsonFile(h.dir, tmpName, { id: VALID_UUID_1, ts: "2026-07-05T00:00:00.000Z", command: "/clear" });

      // No sensible "wait for absence of an event" — wait out a few sweep
      // ticks, then assert nothing happened and the file is untouched.
      await new Promise(r => setTimeout(r, 80));

      expect(fs.existsSync(path.join(h.dir, tmpName))).toBe(true);
      expect(h.injects.length).toBe(0);
      expect(h.envs.length).toBe(0);
      expect(h.statuses.length).toBe(0);
    } finally {
      h.stop();
    }
  });
});

describe("pending-consumer — stop() and deferred timer cancellation (Fix 3: SCAR-022)", () => {
  test("stop() prevents deferred timers and new files from being processed", async () => {
    const h = startHarness("stop-cancel-timers");
    try {
      // Start with one file to process normally
      const filename1 = `${VALID_UUID_1}.json`;
      writeJsonFile(h.dir, filename1, { id: VALID_UUID_1, ts: "2026-07-05T00:00:00.000Z", command: "/clear" });

      await waitUntil(() => h.injects.length === 1);

      // Stop the consumer
      h.stop();

      // Give a small window for any in-flight processing
      await new Promise(r => setTimeout(r, 20));

      // Now write a new file after stop
      const filename2 = `${VALID_UUID_2}.json`;
      writeJsonFile(h.dir, filename2, { id: VALID_UUID_2, ts: "2026-07-05T00:00:01.000Z", command: "/rename foo" });

      // Wait a bit to see if it gets processed (it shouldn't)
      await new Promise(r => setTimeout(r, 150));

      // The new file should still exist (not processed/deleted)
      expect(fs.existsSync(path.join(h.dir, filename2))).toBe(true);
      // And no injection for the second file
      expect(h.injects.length).toBe(1);
    } finally {
      h.stop(); // cleanup
    }
  });
});

describe("pending-consumer — SCAR-022 retry on EPERM/EBUSY", () => {
  test("a rename (quarantine) that fails once with EPERM succeeds on retry", async () => {
    const dir = tmpPendingDir("retry-eperm");
    let renameCalls = 0;
    const fsOps: Partial<PendingFsOps> = {
      rename: (from, to) => {
        renameCalls++;
        if (renameCalls === 1) {
          const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        fs.renameSync(from, to);
      },
    };
    const statuses: PendingStatus[] = [];
    const handle = startPendingConsumer({
      dir,
      botId: "bot-06",
      enqueueEnv: () => true,
      enqueueInject: () => {},
      onStatus: s => statuses.push(s),
      deferMs: 5,
      sweepIntervalMs: 20,
      fsOps,
    });
    try {
      const filename = `${VALID_UUID_1}.json`;
      writeJsonFile(dir, filename, "not json at all {{{");

      await waitUntil(() => fs.readdirSync(dir).some(f => f.startsWith(`${filename}.rejected-`)), 3_000);

      expect(renameCalls).toBeGreaterThanOrEqual(2);
      expect(statuses.some(s => s.level === "warning" && s.message.includes("quarantined"))).toBe(true);
      // No .rejected-partial file lingers from the failed first attempt.
      expect(fs.existsSync(path.join(dir, filename))).toBe(false);
    } finally {
      handle.stop();
    }
  });
});
