# mirza-harness

Substrat baru fleet bot Claude Code milik Mirza: daemon `hostd` (supervisor + bus + state SQLite + channel adapters), `pty-holder` tipis, dan plugin `cc-stub`.

- Design doc: `mirza-marketplace/docs/2026-07-03-harness-rewrite-design.md`
- Kontrak penerimaan: inventaris 529 item di `mirza-marketplace/docs/2026-07-02-capability-inventory/`
- Status: Fase 0 (skeleton). Sistem lama tetap produksi sampai migrasi selesai.
- Konstrain mutlak: TANPA Claude Agent SDK / `claude -p` — seluruh usage lewat TUI interaktif.

## Perintah
- `bun install`
- `bun test`
- `bun run typecheck`
- `bun run packages/hostd/src/main.ts` — jalankan daemon
- `bun run packages/hostd/src/cli.ts doctor` — tanya kesehatan daemon
