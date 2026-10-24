/**
 * 0010 spike store: the new chat runtime's own tables. The source of
 * truth is `messages` rows with a serialized ModelMessage (the eve
 * event mirror these once coexisted with was retired by 0032).
 *
 * Rows are append-only and read back in insertion order (rowid); ids are
 * content-stable per turn so step retries cannot duplicate them.
 *
 * Split by concern into this directory, re-exported here so every
 * existing `@/db/chat` / `../db/chat` import keeps resolving unchanged:
 *  - ./messages        — message persistence (append/list, row + metadata types)
 *  - ./conversations   — conversation CRUD, settings columns, and the
 *                        start_thread child/wake bookkeeping
 *  - ./steer           — the mid-turn steer queue
 *  - ./run-state       — active-run / stream-cursor / harness resume state
 *  - ./pending-inputs  — ask_chad/ask_owner pending-input records (the
 *                        write side; db/attention.ts reads them for the inbox)
 */
export * from "./messages";
export * from "./conversations";
export * from "./steer";
export * from "./run-state";
export * from "./pending-inputs";
