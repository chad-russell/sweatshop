"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { UIMessage } from "ai";
import type { UseChatHelpers } from "@ai-sdk/react";
import { fetchChatPage } from "@/lib/chat-fetch";
import { rowsToUIMessages } from "@/lib/chat-ui";
import { PAGE_TAIL } from "./constants";

/** A live run this tab is not currently streaming, named and positioned
 *  for the cursor-based reconnect (see useResumeStream). */
export interface PendingResume {
  runId: string;
  cursor: number;
}

/**
 * 0077: a live run this tab is not currently streaming — seeded at
 * mount from the hydrated activeRunId/activeStreamCursor (props), or
 * discovered later (the settled-context fetch, the wake poll). Read
 * by prepareReconnectToStreamRequest to build the cursor-based
 * reconnect URL; useResumeStream clears it once its resumeStream()
 * call finishes.
 */
export function usePendingResume(
  activeRunId: string | null | undefined,
  activeStreamCursor: number | null | undefined,
) {
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(
    () => (activeRunId ? { runId: activeRunId, cursor: activeStreamCursor ?? 0 } : null),
  );
  const pendingResumeRef = useRef(pendingResume);
  useEffect(() => {
    pendingResumeRef.current = pendingResume;
  }, [pendingResume]);

  return { pendingResume, setPendingResume, pendingResumeRef };
}

/**
 * 0077: resume the AI SDK's own durable stream onto a known live run
 * (pendingResume — seeded at mount, or discovered below) once this
 * tab is idle. `chat.resumeStream()` reconnects via the transport's
 * `prepareReconnectToStreamRequest` (the cursor-based URL above);
 * `status` tracks it exactly like a fresh send (submitted → streaming
 * → ready), so the thinking indicator and Stop button need no
 * separate "live elsewhere" term. Once the stream ends, reload the
 * tail from the store: a resumed stream may land as a NEW assistant
 * UIMessage rather than continuing the hydrated fold (useChat only
 * replaces the last message when the resumed message's id matches it,
 * and the cursor-based stream's first chunk carries a fresh id — see
 * docs/0077 decision 3) — reloading re-folds the turn exactly as a
 * fresh load would show it.
 */
export function useResumeStream({
  chat,
  chatRef,
  conversationId,
  pendingResume,
  setPendingResume,
  setOlderCursor,
  setOlderRemaining,
}: {
  chat: UseChatHelpers<UIMessage>;
  chatRef: MutableRefObject<UseChatHelpers<UIMessage>>;
  conversationId: string;
  pendingResume: PendingResume | null;
  setPendingResume: (value: PendingResume | null) => void;
  setOlderCursor: (value: number | null) => void;
  setOlderRemaining: (value: number) => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the run identity, not every re-render.
  useEffect(() => {
    if (!pendingResume) return;
    let cancelled = false;
    void (async () => {
      try {
        await chat.resumeStream();
        if (cancelled) return;
        const page = await fetchChatPage(conversationId, { tail: PAGE_TAIL });
        if (!page || cancelled) return;
        setOlderCursor(page.olderCursor);
        setOlderRemaining(page.olderRemaining);
        chatRef.current.setMessages(rowsToUIMessages(page.rows));
      } finally {
        if (!cancelled) setPendingResume(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingResume?.runId, conversationId]);
}
