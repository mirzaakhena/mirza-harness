// @mirza-harness/pty-holder — public, node-pty-free surface (pacing logic +
// IPC protocol schemas/types). Deliberately does NOT re-export `pty.ts` or
// `main.ts`: those touch the native node-pty module, and this barrel must
// stay safe to import (e.g. from a future supervisor package) without
// dragging that in. Run the holder itself via `main.ts` (see README).
export * from "./inject";
export * from "./ipc";
