# E1 — Runbook uji live (Fase 1, hostd)

Ringkas, operasional. Tujuan: verifikasi jalur pairing -> approve -> delivery
(DM, album, buttons, agent_send) sungguh jalan end-to-end lewat permukaan
produk (bukan cuma unit test), pakai bot-07 + cc-stub di workspace uji.

## 0. Prasyarat

- `bun install` sudah jalan di root repo (`mirza-harness`).
- Config `hostd.config.json` (root, atau path via `MIRZA_HOSTD_CONFIG`) berisi
  entri bot-07 dgn `telegram_token` asli (lihat `hostd.config.example.json`).
  Contoh:
  ```json
  { "bots": [{ "id": "bot-07", "telegram_token": "<token asli>", "workspace": "<path workspace uji>" }] }
  ```
- Pilih path DB eksplisit untuk sesi uji ini (jangan pakai `./hostd.db` default
  supaya gampang dibuang setelah selesai):
  `MIRZA_HOSTD_DB=./e1-hostd.db`
- Pipe default `PIPE_NAME_DEFAULT` (shared) dipakai kalau `MIRZA_HOSTD_PIPE`
  tak di-set — cukup untuk satu instance hostd + satu cc-stub lokal.

## 1. Boot hostd

```
MIRZA_HOSTD_DB=./e1-hostd.db MIRZA_HOSTD_CONFIG=./hostd.config.json \
  bun run packages/hostd/src/main.ts
```

Tunggu log `[hostd] vX.Y.Z siap — pipe: ... (pid ...)`. Biarkan proses ini
jalan di terminal sendiri sepanjang sesi uji.

## 2. Boot cc-stub di workspace uji

Di terminal kedua, di dalam workspace uji (path yang sama dgn `workspace`
bot-07 di config):

```
MIRZA_HOSTD_PIPE=<pipe yang sama dgn hostd> bun run packages/cc-stub/src/server.ts
```

cc-stub konek ke pipe hostd yang sama dan mendaftar sbg penerima delivery
untuk bot-07.

## 3. Pairing: dapatkan kode

Dari akun Telegram uji, kirim DM ke bot-07 (dmPolicy default = `pairing`,
belum ada siapa pun di `allowFrom`). Bot akan membalas kode pairing
(pairing-reply lewat `Api.sendMessage` langsung — lihat komentar main.ts
soal ini bypass `OutboundSender`). Catat `user_id` pengirim (angka Telegram
user id, BUKAN username) dan kode — bisa juga dicek langsung:

```
bun run packages/hostd/src/cli.ts access show bot-07
```

`pending` di output JSON berisi map `code -> {senderId, chatId, ...}` —
`senderId` itu `user_id` yang dipakai di langkah 4.

CATATAN (expected, bukan bug): sebelum approve, SETIAP pesan dari sender
unpaired dibalas pairing-reply lagi (kode yang sama di-reuse) — cap
"maks 2 balasan" belum aktif (MINOR-1, backlog fase 2).

## 4. Approve pairing (jalur produk — BLOCKER yang baru di-fix)

```
bun run packages/hostd/src/cli.ts access approve bot-07 <user_id>
```

Ini memanggil `approvePairing` (state/access-store.ts) atas DB yang SAMA
yang dibaca hostd (`openDb` yang sama, WAL + busy_timeout — aman ditulis
dari proses CLI terpisah selagi hostd jalan). Cetak ringkas `allowFrom` +
sisa `pending` setelah approve.

Verifikasi cepat:

```
bun run packages/hostd/src/cli.ts access show bot-07
```

`allowFrom` harus memuat `<user_id>`, `pending` harus tak lagi memuat kode
tsb.

Jalur darurat (skip kode pairing sepenuhnya, mis. testing cepat atau
approve tanpa menunggu user kirim DM lagi):

```
bun run packages/hostd/src/cli.ts access allow bot-07 <user_id>
```

## 5. Verifikasi delivery setelah approve — TANPA restart

- **DM**: kirim DM lagi dari akun yang baru di-approve -> harus deliver
  (masuk ke `messages` store + terlihat cc-stub, tanpa perlu kirim ulang
  kode). Ini yang membuktikan hostd baca `access` FRESH per pesan (lihat
  komentar cli.ts: closure `() => getAccess(db, botId, "telegram")` di
  main.ts query ulang tabel tiap dipanggil, bukan snapshot di-cache saat
  startup) — tidak perlu restart hostd setelah CLI approve.
- **Album**: kirim beberapa foto sekaligus (media group) dari akun yang
  sama -> cek diterima sbg satu unit di sisi cc-stub/messages store.
- **Buttons**: picu path yang mengirim inline keyboard (via cc-stub
  `telegram.outbound` reply dgn buttons) -> tekan salah satu -> callback
  harus balik ke hostd dan diproses.
- **agent_send**: dari cc-stub, panggil tool `agent_send` (bus enqueue) ke
  bot lain yang terdaftar -> cek `bus`/`delivery` stats via doctor (langkah 6)
  naik sesuai.

## 6. Doctor — cara baca yang benar

```
bun run packages/hostd/src/cli.ts doctor
```

**JANGAN** jadikan field `ok` sebagai sinyal kesehatan — `ok: true`
di-hardcode di `doctor.ts` (limitasi tercatat, bukan bug baru). Yang
benar-benar informatif:

- `components.adapters` — harus JSON `{<bot_id>: "running"}` per bot
  terkonfigurasi, BUKAN string `"stub"` (stub berarti adapter belum wired /
  belum start).
- `components.bus` — harus JSON stats (`queued`, `dead`,
  `oldest_unacked_s`, dan field `delivery` kalau delivery loop jalan),
  BUKAN string `"stub"`.

Kalau salah satu masih `"stub"` setelah hostd boot, itu tanda wiring belum
lengkap — cek log boot hostd dan config bot.

## 7. Bersih-bersih

- Hentikan cc-stub (`Ctrl+C`), lalu hostd (`SIGINT`/`Ctrl+C` — sudah ada
  handler shutdown rapi di main.ts).
- Hapus file DB uji: `rm -f e1-hostd.db e1-hostd.db-wal e1-hostd.db-shm`
  (WAL menghasilkan file sidecar `-wal`/`-shm`).
