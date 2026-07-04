import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, type AtomicFsOps } from "../src/atomic-write";

function tmpDir(name: string): string {
  const dir = path.join(
    os.tmpdir(),
    `mirza-shared-atomic-write-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function eperm(): NodeJS.ErrnoException {
  const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
  err.code = "EPERM";
  return err;
}

function ebusy(): NodeJS.ErrnoException {
  const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
  err.code = "EBUSY";
  return err;
}

describe("atomicWriteFile — happy path", () => {
  test("writes via tmp+rename, final file has content, no leftover tmp file", async () => {
    const dir = tmpDir("happy");
    const target = path.join(dir, "wrapper.state.json");
    await atomicWriteFile(target, '{"a":1}');

    expect(fs.readFileSync(target, "utf8")).toBe('{"a":1}');
    const leftovers = fs.readdirSync(dir).filter(f => f.includes(".tmp."));
    expect(leftovers.length).toBe(0);
  });

  test("creates missing parent directory", async () => {
    const dir = tmpDir("mkdir");
    const target = path.join(dir, "nested", "deep", "file.txt");
    await atomicWriteFile(target, "hello");
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
  });

  test("a real writer never observes a partial file (tmp write then atomic rename)", async () => {
    const dir = tmpDir("atomicity");
    const target = path.join(dir, "wrapper.heartbeat");
    let sawTmpDuringWrite = false;
    const fsOps: Partial<AtomicFsOps> = {
      writeFile: (p, d) => {
        fs.writeFileSync(p, d);
        // At this point the tmp file exists but the final path must not yet.
        if (fs.existsSync(target)) sawTmpDuringWrite = true;
      },
    };
    await atomicWriteFile(target, "2026-07-05T00:00:00.000Z", { fsOps });
    expect(sawTmpDuringWrite).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("atomicWriteFile — SCAR-022 EPERM/EBUSY retry", () => {
  test("rename failing with EPERM once then succeeding is retried transparently", async () => {
    const dir = tmpDir("retry-eperm");
    const target = path.join(dir, "wrapper.pid");
    let renameCalls = 0;
    const fsOps: Partial<AtomicFsOps> = {
      rename: (from, to) => {
        renameCalls++;
        if (renameCalls === 1) throw eperm();
        fs.renameSync(from, to);
      },
    };
    await atomicWriteFile(target, "12345", { fsOps });
    expect(renameCalls).toBe(2);
    expect(fs.readFileSync(target, "utf8")).toBe("12345");
  });

  test("rename failing with EBUSY twice then succeeding is retried transparently", async () => {
    const dir = tmpDir("retry-ebusy");
    const target = path.join(dir, "wrapper.pid");
    let renameCalls = 0;
    const fsOps: Partial<AtomicFsOps> = {
      rename: (from, to) => {
        renameCalls++;
        if (renameCalls <= 2) throw ebusy();
        fs.renameSync(from, to);
      },
    };
    await atomicWriteFile(target, "999", { fsOps });
    expect(renameCalls).toBe(3);
    expect(fs.readFileSync(target, "utf8")).toBe("999");
  });

  test("exhausting all 5 attempts on persistent EPERM propagates the error", async () => {
    const dir = tmpDir("retry-exhausted");
    const target = path.join(dir, "wrapper.pid");
    let renameCalls = 0;
    const fsOps: Partial<AtomicFsOps> = {
      rename: () => {
        renameCalls++;
        throw eperm();
      },
    };
    await expect(atomicWriteFile(target, "x", { fsOps })).rejects.toThrow();
    expect(renameCalls).toBe(5);
  });

  test("a non-retryable error (e.g. ENOENT) is NOT retried", async () => {
    const dir = tmpDir("no-retry-other-error");
    const target = path.join(dir, "wrapper.pid");
    let renameCalls = 0;
    const fsOps: Partial<AtomicFsOps> = {
      rename: () => {
        renameCalls++;
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    };
    await expect(atomicWriteFile(target, "x", { fsOps })).rejects.toThrow();
    expect(renameCalls).toBe(1);
  });

  test("non-retryable error cleans up tmp file before propagating (SCAR-022 hygiene)", async () => {
    const dir = tmpDir("cleanup-non-retryable");
    const target = path.join(dir, "wrapper.state.json");
    const fsOps: Partial<AtomicFsOps> = {
      rename: () => {
        const err = new Error("EPERM: operation not permitted, unlink") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      },
    };
    await expect(atomicWriteFile(target, "data", { fsOps, tmpSuffix: "test-non-retryable" })).rejects.toThrow("EPERM");
    const leftovers = fs.readdirSync(dir).filter(f => f.includes(".tmp."));
    expect(leftovers.length).toBe(0);
  });

  test("retry exhausted cleans up tmp file before propagating (SCAR-022 hygiene)", async () => {
    const dir = tmpDir("cleanup-exhausted");
    const target = path.join(dir, "wrapper.state.json");
    let renameCalls = 0;
    const fsOps: Partial<AtomicFsOps> = {
      rename: () => {
        renameCalls++;
        throw ebusy();
      },
    };
    await expect(atomicWriteFile(target, "data", { fsOps, tmpSuffix: "test-exhausted" })).rejects.toThrow("EBUSY");
    expect(renameCalls).toBe(5);
    const leftovers = fs.readdirSync(dir).filter(f => f.includes(".tmp."));
    expect(leftovers.length).toBe(0);
  });
});
