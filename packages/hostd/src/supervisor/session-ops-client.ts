import type { SessionOpsClient } from "@mirza-harness/telegram-adapter";
import type { SessionOps } from "./session-ops";

/**
 * Task E1' (Fase 2 assembly) — thin Promise-wrapping adaptor from S2's
 * `SessionOps` (session-ops.ts; a mix of sync and already-async methods) onto
 * M1's `SessionOpsClient` interface (`packages/telegram-adapter/src/meta-commands.ts`),
 * which models an RPC boundary (every method Promise-returning) even though
 * telegram-adapter and hostd's `SessionOps` run IN-PROCESS here — meta-commands.ts's
 * own docstring documents this exact production/test split ("in production it
 * is backed by an RPC call into hostd, in tests by a fake" — for THIS repo,
 * hostd IS the process that owns both telegram-adapter and session-ops.ts, so
 * there is no actual RPC hop; this file is the "production" implementation,
 * just realized as a same-process adaptor instead of a network client).
 *
 * `MetaCommandBot`/hostd's `SessionOpsBot` are structurally identical
 * (`{id, workspace}`) — no conversion needed on the bot parameter itself.
 * Deliberately NOT modifying session-ops.ts or meta-commands.ts (both already
 * committed & tested per the E1' brief) — this file exists purely to bridge
 * the two shapes at the wiring layer (main.ts).
 */
export function createSessionOpsClient(ops: SessionOps): SessionOpsClient {
  return {
    listSessions: bot => Promise.resolve(ops.listSessions(bot)),
    currentSession: bot => Promise.resolve(ops.currentSession(bot)),
    isAlive: bot => Promise.resolve(ops.isAlive(bot)),
    resume: (bot, sessionId) => Promise.resolve(ops.resume(bot, sessionId)),
    rename: (bot, name) => ops.rename(bot, name),
    clearSession: (bot, opts) => ops.clearSession(bot, opts),
    setEffort: (bot, level) => Promise.resolve(ops.setEffort(bot, level)),
    archiveSession: (bot, sessionId) => Promise.resolve(ops.archiveSession(bot, sessionId)),
    hardDelete: (bot, sessionId) => Promise.resolve(ops.hardDelete(bot, sessionId)),
    bulkArchive: (bot, exceptCurrent) => Promise.resolve(ops.bulkArchive(bot, exceptCurrent)),
    bulkDelete: (bot, exceptCurrent) => Promise.resolve(ops.bulkDelete(bot, exceptCurrent)),
  };
}
