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
