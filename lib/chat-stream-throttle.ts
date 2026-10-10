/**
 * Throttle for useChat message updates (2026-10-10 live-turn regression).
 *
 * A long turn replays and streams as ONE growing assistant message, and
 * the AI SDK applies EVERY state-writing stream chunk with a synchronous
 * notify (ReactChatState.replaceMessage clones the message's parts and
 * re-renders). A GLM route with thinking on emits reasoning deltas
 * token-by-token — one review-thread turn measured 43k chunks / 2.7 MiB
 * (95% reasoning deltas, ~160/s), each re-rendering the whole transcript:
 * the page pegged the main thread for the entire catch-up replay.
 *
 * 50 ms (20 updates/s) keeps streaming visually live while bounding
 * renders on both the live and the reconnect-replay paths. The store
 * state itself is never throttled — only subscriber notification — so
 * the final message is always complete (see tests/chat-stream-throttle).
 */
export const CHAT_STREAM_THROTTLE_MS = 50;
