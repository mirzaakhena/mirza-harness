// @mirza-harness/telegram-adapter — pure telegram modules (Task C1, Fase 1).
export * from "./album-buffer";
export * from "./buttons";
export * from "./markdown";
export * from "./paginated-picker";
export * from "./chunk";
// Task C3, Fase 1 — poller lifecycle grammy supervised.
export * from "./poller";
export * from "./gate";
// Task C4, Fase 1 — inbound pipeline gate->media/album/callback->store->bus.
export * from "./inbound";
// Task C5, Fase 1 — outbound sender (reply/react/download_attachment/get_message_by_id).
export * from "./outbound";
// Task M1, Fase 2 — meta-command router (/new /switch /rename /delete /effort) over session-ops.
export * from "./meta-commands";
// Task M2, Fase 2 — /context + /version reply rendering (telemetry from sessions, INFRA-5/FUNC-1/VER-1).
export * from "./context-command";
