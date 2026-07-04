import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Config hostd — Task C3, Fase 1. Dibaca dari `MIRZA_HOSTD_CONFIG` (path
 * eksplisit) atau default `hostd.config.json` di `process.cwd()`. Bentuk:
 * `{bots: [{id, telegram_token, workspace}]}` — lihat `hostd.config.example.json`
 * di root repo untuk contoh isi.
 *
 * LOSS-5 (kelas bug diport dari kode acuan): token Telegram sering
 * ter-copy-paste dengan spasi/CRLF/BOM menempel (dari .env, clipboard lintas
 * OS, dsb). Kode acuan membaca token langsung dari env tanpa sanitasi —
 * token yang kelihatan benar di mata manusia gagal auth secara diam-diam
 * (Telegram menolak token dengan whitespace di dalamnya). Di sini
 * `telegram_token` di-trim otomatis (BOM + whitespace/CR/LF di ujung) DAN
 * divalidasi formatnya (`<numeric_id>:<35+ char>`) sebelum dipakai — gagal
 * validasi menghasilkan pesan error yang jelas saat load, bukan kegagalan
 * auth yang membingungkan saat runtime.
 */

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

const DEFAULT_CONFIG_FILENAME = "hostd.config.json";

/** Strip BOM di awal + trim whitespace/CR/LF di ujung (LOSS-5). */
function cleanToken(raw: string): string {
  return raw.replace(/^﻿/, "").trim();
}

const BotConfigSchema = z
  .object({
    id: z.string().min(1, "bots[].id tidak boleh kosong"),
    telegram_token: z
      .string()
      .transform(cleanToken)
      .refine(
        (t) => TELEGRAM_TOKEN_RE.test(t),
        (t) => ({
          message:
            `telegram_token tidak valid setelah di-trim: "${t}". ` +
            `Format yang benar: <id numerik>:<35+ karakter alfanumerik/_/->, ` +
            `contoh "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ` +
            `(lihat hostd.config.example.json di root repo).`,
        }),
      ),
    workspace: z.string().min(1, "bots[].workspace tidak boleh kosong"),
  })
  .strict();

export const HostdConfigSchema = z
  .object({
    bots: z.array(BotConfigSchema),
  })
  .strict();

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type HostdConfig = z.infer<typeof HostdConfigSchema>;

function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim().length > 0) return explicitPath;
  const fromEnv = process.env.MIRZA_HOSTD_CONFIG;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
}

/**
 * Baca + validasi config hostd. `path` eksplisit menang atas
 * `MIRZA_HOSTD_CONFIG`, yang menang atas default `./hostd.config.json`.
 * Melempar `Error` dengan pesan jelas (menyebut path yang dicoba + contoh)
 * bila file tidak ada, bukan JSON valid, atau gagal validasi skema.
 */
export function loadConfig(path?: string): HostdConfig {
  const configPath = resolveConfigPath(path);

  if (!existsSync(configPath)) {
    throw new Error(
      `hostd config tidak ditemukan: ${configPath}\n` +
        `  set env MIRZA_HOSTD_CONFIG=<path ke file config>, atau taruh ` +
        `"${DEFAULT_CONFIG_FILENAME}" di working directory tempat hostd dijalankan.\n` +
        `  contoh isi: lihat hostd.config.example.json di root repo mirza-harness ` +
        `(salin ke ${DEFAULT_CONFIG_FILENAME} lalu isi telegram_token asli).`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`gagal baca hostd config di ${configPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `hostd config di ${configPath} bukan JSON valid: ${(err as Error).message}`,
    );
  }

  const result = HostdConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`hostd config di ${configPath} tidak valid:\n${issues}`);
  }

  return result.data;
}
