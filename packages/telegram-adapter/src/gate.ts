import { randomBytes } from "node:crypto";
import { PENDING_CAP, type Access } from "@mirza-harness/shared";

/**
 * Port dari `gate()` + pairing flow, `plugins/telegram/server.ts:209-420`
 * (mirza-marketplace). Ditulis ulang sebagai fungsi murni: tidak ada fs/DB,
 * tidak ada `Math.random`/`Date.now()` implisit (keduanya bisa disuntik lewat
 * `opts` untuk testability) — semua state (access, pending, allowFrom) masuk
 * lewat parameter, semua keputusan keluar lewat return value. Persistensi
 * (saveAccess/addPending/approvePairing) adalah tanggung jawab pemanggil
 * (hostd), bukan modul ini — lihat `packages/hostd/src/state/access-store.ts`.
 *
 * Fix keamanan dibanding kode acuan (lihat task-C2-brief.md):
 * - SEC-1: kode acuan lama punya `dmCommandGate()` terpisah yang HANYA
 *   menolak dmPolicy 'allowlist' non-allowFrom — di dmPolicy 'pairing',
 *   siapa pun bisa memicu /context /version tanpa pernah pairing (bocor
 *   info). Di sini `isInfoCommand` tidak dapat jalur longgar sendiri: ia
 *   melewati logika private-chat yang SAMA dengan pesan biasa (harus
 *   allowFrom untuk 'deliver'; stranger di dmPolicy 'pairing' jatuh ke alur
 *   pairing biasa, bukan bocor apa pun), dan selalu drop di grup (command
 *   itu DM-only).
 * - SEC-2: sinyal meta-command/permission-reply (dipakai fase 2 untuk
 *   permission-reply routing & meta-command seperti /telegram:access) HANYA
 *   lolos bila chatType === 'private' DAN sender ada di allowFrom. Namun
 *   dmPolicy 'disabled' adalah kill-switch total: ia menang atas exemption
 *   SEC-2 dan mengakibatkan drop sebelum SEC-2 logic ditjalankan. Selain itu
 *   (dmPolicy selain 'disabled' + kondisi SEC-2 tak terpenuhi) langsung drop
 *   dengan reason.
 */

export type ChatType = "private" | "group" | "supergroup" | (string & {});

export interface GateInput {
  chatType: ChatType;
  chatId: string;
  senderId: string;
  text?: string;
  /** True bila caller sudah mendeteksi mention entity (@bot) atau text_mention utk bot. */
  mentionsBot?: boolean;
  /** True bila pesan ini reply ke pesan bot sebelumnya (implicit mention). */
  replyToBot?: boolean;
  /** Perintah kelas info (/context, /version, dst.) — lihat SEC-1. */
  isInfoCommand?: boolean;
  /** Meta-command (mis. /telegram:access) — lihat SEC-2. */
  isMetaCommand?: boolean;
  /** Balasan ke prompt permission Claude Code — lihat SEC-2. */
  isPermissionReply?: boolean;
}

export type GateResult =
  | { action: "deliver" }
  | { action: "drop"; reason: string }
  | { action: "pairing-reply"; code: string; isResend: boolean };

export interface GateOptions {
  /** Injectable clock — default `Date.now()`. Dipakai utk menilai `expiresAt` pending. */
  now?: number;
  /** Injectable code generator — default 6 hex char (`randomBytes(3)`), sama seperti kode acuan. */
  generateCode?: () => string;
}

function defaultGenerateCode(): string {
  return randomBytes(3).toString("hex"); // 6 hex chars
}

function isMentioned(input: GateInput, mentionPatterns?: string[]): boolean {
  if (input.mentionsBot) return true;
  if (input.replyToBot) return true;
  const text = input.text ?? "";
  for (const pat of mentionPatterns ?? []) {
    try {
      if (new RegExp(pat, "i").test(text)) return true;
    } catch {
      // Invalid user-supplied regex — skip it, same as kode acuan.
    }
  }
  return false;
}

function pairingFlow(input: GateInput, access: Access, now: number, generateCode: () => string): GateResult {
  const active = Object.entries(access.pending).filter(([, p]) => p.expiresAt >= now);

  const existing = active.find(([, p]) => p.senderId === input.senderId);
  if (existing) {
    const [code, p] = existing;
    // Reply twice max (initial + one reminder), then go silent — same cap as kode acuan.
    if ((p.replies ?? 1) >= 2) return { action: "drop", reason: "pairing reply cap reached" };
    return { action: "pairing-reply", code, isResend: true };
  }

  if (active.length >= PENDING_CAP) {
    return { action: "drop", reason: `pending cap (${PENDING_CAP}) reached` };
  }

  return { action: "pairing-reply", code: generateCode(), isResend: false };
}

export function gate(input: GateInput, access: Access, opts: GateOptions = {}): GateResult {
  const now = opts.now ?? Date.now();
  const generateCode = opts.generateCode ?? defaultGenerateCode;

  if (access.dmPolicy === "disabled") {
    return { action: "drop", reason: "dmPolicy disabled" };
  }

  // SEC-2: meta-command / permission-reply are reserved, private-only signals —
  // they never fall through to group mention/allowlist logic or to the
  // pairing flow, regardless of dmPolicy.
  if (input.isMetaCommand || input.isPermissionReply) {
    if (input.chatType === "private" && access.allowFrom.includes(input.senderId)) {
      return { action: "deliver" };
    }
    return {
      action: "drop",
      reason: "meta-command/permission-reply requires chatType='private' and sender in allowFrom",
    };
  }

  if (input.chatType === "private") {
    if (access.allowFrom.includes(input.senderId)) return { action: "deliver" };

    // SEC-1: isInfoCommand does NOT get a separate lenient check — a stranger
    // falls through to the exact same allowlist/pairing handling as a normal
    // message, so /context /version can never leak info pre-pairing.
    if (access.dmPolicy === "allowlist") {
      return { action: "drop", reason: "sender not in allowFrom (dmPolicy allowlist)" };
    }

    return pairingFlow(input, access, now, generateCode);
  }

  if (input.chatType === "group" || input.chatType === "supergroup") {
    // Commands are DM-only (see kode acuan comment above bot.command('start', ...)):
    // responding in groups would leak pairing codes / confirm bot presence /
    // spam non-approved channels. isInfoCommand never delivers in a group.
    if (input.isInfoCommand) {
      return { action: "drop", reason: "info commands are DM-only" };
    }

    const policy = access.groups[input.chatId];
    if (!policy) return { action: "drop", reason: "group not allowlisted" };

    const groupAllowFrom = policy.allowFrom ?? [];
    const requireMention = policy.requireMention ?? true;
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(input.senderId)) {
      return { action: "drop", reason: "sender not in group allowFrom" };
    }
    if (requireMention && !isMentioned(input, access.mentionPatterns)) {
      return { action: "drop", reason: "mention required" };
    }
    return { action: "deliver" };
  }

  return { action: "drop", reason: `unknown chatType: ${String(input.chatType)}` };
}
