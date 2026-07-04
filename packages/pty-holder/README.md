# @mirza-harness/pty-holder

Thin child process that holds one PTY-spawned Claude Code session and speaks
a stdio NDJSON JSON-RPC protocol with its parent — see `src/ipc.ts` for the
wire contract (`inject` / `inject-slash` / `resize` / `shutdown` requests,
`pty-exit` / `pty-error` / `injected` events). It has no knowledge of
session ids, session names, or the supervisor's injection barrier/queue —
that all lives one layer up (recon-wrapper §A).

## Runtime: Node, not Bun

`node-pty` is a native addon compiled against Node's ABI. It is not known to
build/load correctly under Bun's runtime, so this package's *executable*
code (`pty.ts`, `main.ts` — anything that imports `node-pty`) always runs
under **Node** (`engines.node >= 18`), started via:

```sh
node --import tsx src/main.ts
```

`tsx` transpiles the `.ts` entry on the fly — the same approach the
reference wrapper used (`plugins/pty-controller/wrapper/package.json`'s
`"wrapper": "tsx src/wrapper.ts"` script), proven to work with node-pty. A
compiled `dist/` build (`tsc`/`esbuild`) is an equally valid alternative for
a future phase that wants to drop the `tsx` runtime dependency in
production; not done here since `tsx` is already the proven path and keeps
this package's setup identical to kode acuan.

The **pure logic** — `inject.ts` (chunk/pacing math) and `ipc.ts` (zod
schemas + envelope builders) — imports nothing native and has no such
constraint.

## Tests

- `bun test packages/pty-holder` (or from the repo root: `bun test`) — unit
  tests for `inject.ts` and `ipc.ts` only. No `node-pty` import anywhere in
  this suite, so it's safe to run under Bun's test runner.
- `test-integration.mjs` — a REAL end-to-end smoke test: spawns an actual PTY
  (via `node-pty`) running a plain interactive shell (`cmd.exe` on Windows /
  `$SHELL -i` elsewhere — deliberately **not** `claude`), then drives it
  through this package's real `planInject` / `planInjectSlash` / `runPlan`
  and asserts the typed text — including a body spanning multiple
  100-code-point chunks — arrives at the shell intact. This touches the
  native module, so it is intentionally **not** part of `bun test`; run it
  manually from this package directory:

  ```sh
  node --import tsx test-integration.mjs
  # or, via the package script:
  npm run test:integration
  bun run test:integration
  ```

## Exit-time contract (S1)

`node-pty` on Windows shells out to a helper fork (`conpty_console_list_agent`,
its ConPTY console-enumeration helper) whenever a `kill()`-related path runs.
When this holder's stdio is piped with no attached console — i.e. **every**
normal way a supervisor spawns it — that helper fork throws an uncaught
`AttachConsole failed` in its own separate process. This is not a rare edge
case: it reproduces on the plain, successful exit path every single time
(confirmed via direct repro, 5 driver scripts). A `try/catch` around this
holder's own `pty.kill()` call cannot catch it, because the throw happens in
a different OS process.

Consequences this package's exit logic is built around:

- **Natural exit** (the held process — `claude`/shell — dies on its own):
  `main.ts` does **not** call `pty.kill()` again on that path (the handle is
  already dead; a redundant `kill()` is what triggers the crash above). It
  goes straight to `process.exit()` once the `pty-exit` event has been
  flushed to stdout.
- **Explicit `shutdown`** (RPC request or `SIGTERM`): `pty.kill()` is still
  attempted (best-effort, wrapped in `try/catch` for its own synchronous
  throws), but the process does **not** wait for the event loop to drain
  naturally afterward — that can stall for 6-12+ seconds while the helper
  fork's handle lingers. Instead `main.ts` force-calls `process.exit(code)`
  after a bounded grace window (`SHUTDOWN_GRACE_MS`, 1500ms), short-circuited
  early if the held process reports its own exit first. The `shutdown`
  RPC's `{ok: true}` response (and the `pty-exit` event, on the natural-exit
  path) is written with a flush callback and only proceeds to exit once that
  write has been handed off — so the supervisor is never left wondering
  whether its request was acknowledged.

**What this means for callers (the supervisor):** do **not** assume this
process exits quickly or deterministically after sending `shutdown` — expect
up to ~`SHUTDOWN_GRACE_MS`. The supervisor **must** still keep its own
independent, OS-level force-kill timeout on the holder's process (e.g. ~5s)
as a fallback of last resort; this package's internal grace window is a
best-effort bound, not a substitute for that supervisor-side safety net.

## Env vars (spawn chain)

- `CLAUDE_BIN` — binary to launch (default `claude`).
- `CLAUDE_ARGS` — space-separated flags appended after `CLAUDE_BIN` (default
  matches kode acuan: `--dangerously-skip-permissions
  --dangerously-load-development-channels
  plugin:telegram@mirza-marketplace`; set to `""` for vanilla `claude`).
- `SHELL` — Unix login shell to spawn through (default `/bin/sh`); ignored on
  Windows, which always launches `cmd.exe /c "<command>"` (SCAR-025).
