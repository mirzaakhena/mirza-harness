import net from "node:net";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { PIPE_NAME_DEFAULT } from "@mirza-harness/shared";
import { openDb } from "./state/db";
import { approvePairing, getAccess, setAccess } from "./state/access-store";

/**
 * fix final-review (approve wiring) — sebelum ini `approvePairing`/`setAccess`
 * (state/access-store.ts, sudah teruji) tak punya caller produksi: satu-
 * satunya permukaan produk (`cli.ts`) cuma `doctor`. Akibatnya user tak
 * pernah bisa masuk `allowFrom` lewat jalur nyata (lihat E1-RUNBOOK.md utk
 * alur uji live lengkap).
 *
 * `access` subcommand membuka DB YANG SAMA yang dipakai proses hostd yang
 * sedang jalan (`resolveDbPath()` — env `MIRZA_HOSTD_DB` atau `<cwd>/hostd.db`,
 * identik main.ts) lewat `openDb` yang sama (WAL + busy_timeout=5000 —
 * aman ditulis dari proses CLI terpisah selagi hostd jalan; JANGAN buka
 * koneksi dgn pragma lain). `openDb` memanggil `applySchema`+`runRetention`
 * tiap kali dibuka — keduanya idempotent, aman dipanggil ulang dari CLI.
 *
 * Fresh-read per pesan: `main.ts` mewire inbound pipeline & outbound sender
 * dengan `access: () => getAccess(db, botId, "telegram")` — sebuah closure
 * yang query ulang tabel `channel_access` tiap dipanggil (bukan snapshot
 * yang di-cache in-memory sekali saat startup). Jadi begitu CLI ini commit
 * baris `channel_access` (proses terpisah, DB file yang sama), pesan
 * BERIKUTNYA yang diproses hostd akan melihatnya tanpa perlu restart.
 */

const USAGE = [
  "pakai:",
  "  cli.ts doctor",
  "  cli.ts access approve <bot_id> <user_id>   # pindah dari pending -> allowFrom",
  "  cli.ts access show <bot_id>                # cetak access JSON",
  "  cli.ts access allow <bot_id> <user_id>     # jalur darurat: tambah allowFrom langsung, lewati kode pairing",
].join("\n");

function resolveDbPath(): string {
  const fromEnv = process.env.MIRZA_HOSTD_DB?.trim();
  if (fromEnv) return fromEnv;
  return join(process.cwd(), "hostd.db");
}

export interface AccessCommandResult {
  exitCode: number;
  output: string;
}

/**
 * Logika `access <sub>` diekstrak dari dispatch CLI supaya testable tanpa
 * `Bun.spawnSync` (test bisa pakai `openDb(":memory:")` langsung). CLI tipis
 * di bawah cuma resolve db path lalu panggil ini.
 */
export function runAccessCommand(db: Database, args: string[]): AccessCommandResult {
  const [sub, botId, userId] = args;

  if (sub === "show") {
    if (!botId) return { exitCode: 2, output: `access show: butuh <bot_id>\n${USAGE}` };
    return { exitCode: 0, output: JSON.stringify(getAccess(db, botId), null, 2) };
  }

  if (sub === "approve") {
    if (!botId || !userId) return { exitCode: 2, output: `access approve: butuh <bot_id> <user_id>\n${USAGE}` };
    const result = approvePairing(db, botId, userId);
    return {
      exitCode: 0,
      output: `approved: ${userId} -> allowFrom (${botId}). allowFrom=${JSON.stringify(result.allowFrom)} pending=${JSON.stringify(Object.keys(result.pending))}`,
    };
  }

  if (sub === "allow") {
    if (!botId || !userId) return { exitCode: 2, output: `access allow: butuh <bot_id> <user_id>\n${USAGE}` };
    const current = getAccess(db, botId);
    if (!current.allowFrom.includes(userId)) current.allowFrom.push(userId);
    const result = setAccess(db, botId, current);
    return {
      exitCode: 0,
      output: `allowed (darurat, tanpa kode pairing): ${userId} -> allowFrom (${botId}). allowFrom=${JSON.stringify(result.allowFrom)}`,
    };
  }

  return { exitCode: 2, output: `access: subcommand tak dikenal '${sub ?? ""}'\n${USAGE}` };
}

function runDoctor(): void {
  const pipe = process.env.MIRZA_HOSTD_PIPE ?? PIPE_NAME_DEFAULT;
  const sock = net.connect(pipe, () => {
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doctor" }) + "\n");
  });
  let buf = "";
  sock.on("data", d => {
    buf += d.toString("utf8");
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      console.log(JSON.stringify(JSON.parse(buf.slice(0, nl)).result, null, 2));
      sock.end();
    }
  });
  sock.on("error", err => {
    console.error(`hostd tidak terjangkau di ${pipe}: ${err.message}`);
    process.exit(1);
  });
}

function main(): void {
  const [cmd, sub2, ...rest] = process.argv.slice(2);

  if (cmd === "doctor") {
    runDoctor();
    return;
  }

  if (cmd === "access") {
    const db = openDb(resolveDbPath());
    const result = runAccessCommand(db, [sub2, ...rest]);
    console.log(result.output);
    db.close();
    process.exit(result.exitCode);
  }

  console.error(USAGE);
  process.exit(2);
}

if (import.meta.main) {
  main();
}
