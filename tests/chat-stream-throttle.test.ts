import { describe, expect, it } from "vitest";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { CHAT_STREAM_THROTTLE_MS } from "../lib/chat-stream-throttle";

/**
 * 2026-10-10: a live review-thread turn (GLM, thinking on) streamed 43k
 * chunks / 2.7 MiB — 95% token-level reasoning deltas — and every
 * state-writing chunk notified subscribers synchronously (one notify per
 * chunk in ReactChatState.replaceMessage), so the transcript re-rendered
 * per token and the page seized for the whole reconnect replay.
 *
 * useChat passes its `throttle` into ~registerMessagesCallback, which is
 * the only bound on that notify storm. These tests pin both sides of the
 * fix at the store seam the component rides on: the storm without the
 * throttle, and the bound with it. (The wiring in ChatSession is one
 * `throttle: CHAT_STREAM_THROTTLE_MS` — kept deliberate.)
 */

/** A replay-shaped chunk stream: mostly reasoning deltas, like the
 * measured turn (reasoning 95%, text 3%, step markers the rest). */
function longTurnChunks(deltas: number): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: "start" }, { type: "start-step" }];
  for (let i = 0; i < deltas; i += 1) {
    const part = `rs${i}`;
    chunks.push({ type: "reasoning-start", id: part });
    chunks.push({ type: "reasoning-delta", id: part, delta: "tok " });
    chunks.push({ type: "reasoning-end", id: part });
    if (i % 30 === 0) {
      chunks.push({ type: "text-start", id: `t${i}` });
      chunks.push({ type: "text-delta", id: `t${i}`, delta: "visible " });
      chunks.push({ type: "text-end", id: `t${i}` });
    }
  }
  chunks.push({ type: "finish-step" }, { type: "finish" });
  return chunks;
}

function transportWith(chunks: UIMessageChunk[]): ChatTransport<UIMessage> {
  return {
    sendMessages: () => {
      throw new Error("not used");
    },
    reconnectToStream: () =>
      Promise.resolve(
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
  };
}

/** Replay the chunk stream through a real Chat and count subscriber
 * notifications — exactly what useChat turns into React re-renders. */
async function replayCountingNotifies(chunks: UIMessageChunk[], throttleMs?: number) {
  const chat = new Chat({ id: "test", transport: transportWith(chunks) });
  let notifies = 0;
  chat["~registerMessagesCallback"](() => {
    notifies += 1;
  }, throttleMs);
  await chat.resumeStream();
  // Let the trailing edge of a throttled callback land.
  await new Promise((resolve) => setTimeout(resolve, CHAT_STREAM_THROTTLE_MS + 20));
  return { chat, notifies };
}

describe("chat stream throttle", () => {
  const DELTAS = 2_000;

  it("without the throttle, every state-writing chunk notifies (the storm)", async () => {
    // 2k reasoning parts × (start + delta + end) + text triples ≈ 6.9k
    // notifies for ~6.9k chunks — one per token-sized chunk.
    const { notifies } = await replayCountingNotifies(longTurnChunks(DELTAS));
    expect(notifies).toBeGreaterThan(DELTAS);
  });

  it("with CHAT_STREAM_THROTTLE_MS, notifies stay bounded and nothing is lost", async () => {
    const { chat, notifies } = await replayCountingNotifies(
      longTurnChunks(DELTAS),
      CHAT_STREAM_THROTTLE_MS,
    );
    // Bounded, not per-chunk: even a slow machine draining for seconds
    // lands orders of magnitude below the unthrottled count.
    expect(notifies).toBeLessThan(300);

    // The store state is never throttled — only notification is — so the
    // final message carries every part with its full text.
    const last = chat.messages.at(-1);
    expect(last?.role).toBe("assistant");
    const reasoning = last?.parts.filter((p) => p.type === "reasoning") ?? [];
    expect(reasoning.length).toBe(DELTAS);
    const text = last?.parts.filter((p) => p.type === "text") ?? [];
    expect(text.length).toBe(Math.ceil(DELTAS / 30));
  });
});
