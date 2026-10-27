"use client";

import { useEffect, type MutableRefObject } from "react";
import type { ChatStatus, UIMessage } from "ai";
import type { UseChatHelpers } from "@ai-sdk/react";
import { appendNewer, rowsToUIMessages } from "@/lib/chat-ui";
import { extendChatPageBack, fetchChatPage } from "@/lib/chat-fetch";
import { PAGE_TAIL } from "./constants";
import type { PendingResume } from "./use-resume";

/** How often an idle chat with background work out checks for its wake. */
const WAKE_POLL_MS = 5000;

/** A live turn owns the transcript — history merges wait for it. (A
 *  helper, not inline compares: TS narrowing of `c.status` survives
 *  `await`, and the status may genuinely change mid-fetch.) */
const busyNow = (c: { status: ChatStatus }) => c.status === "submitted" || c.status === "streaming";

/**
 * 0077: the wake poll's remaining job — notice a turn a background
 * child's settle started SERVER-side while this tab sits fully idle
 * (nothing here is locally reactive, so the server-context settled
 * tick never refires on its own). It only merges already-persisted
 * rows; a live run it finds hands off to the resume effect, never
 * streams itself.
 */
export function useWakePoll({
  awaitingWake,
  conversationId,
  chatRef,
  pendingResumeRef,
  setPendingResume,
}: {
  awaitingWake: boolean;
  conversationId: string;
  chatRef: MutableRefObject<UseChatHelpers<UIMessage>>;
  pendingResumeRef: MutableRefObject<PendingResume | null>;
  setPendingResume: (value: PendingResume | null) => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatRef/pendingResumeRef are stable refs, setPendingResume a stable setter.
  useEffect(() => {
    if (!awaitingWake) return;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const c = chatRef.current;
        if (busyNow(c)) return;
        // The newest tail page, walked back until it ALIGNS with the
        // window: its first row is one we show, or a turn opener we
        // don't. Alignment is what appendNewer needs — a page starting
        // mid-fold could otherwise duplicate text already on screen.
        const known = new Set(c.messages.map((m) => m.id));
        const windowHead = c.messages[0]?.id ?? null;
        let page = await fetchChatPage(conversationId, { tail: PAGE_TAIL });
        if (!page || stop) return;
        if (page.rows[0] != null && !known.has(page.rows[0].id)) {
          // 0076 finding 1: the walk must stop at the WINDOW HEAD (by
          // id) or a t_ row — a page that strides past the head without
          // landing on it spans below the window and corrupts merges.
          // Stopping AT the head yields a page whose first row is known.
          page = await extendChatPageBack(conversationId, page, PAGE_TAIL, (rows) => {
            const first = rows[0];
            return first != null && (first.id === windowHead || known.has(first.id) || first.id.startsWith("t_"));
          });
        }
        // A send may have started while the fetches were out — appending
        // stored history under an optimistic send would misorder the turn.
        if (stop || busyNow(c)) return;
        const stored = rowsToUIMessages(page.rows);
        if (!stored.every((m) => known.has(m.id))) {
          c.setMessages((prev) => appendNewer(prev, stored));
        }
        if (page.activeRunId && page.activeRunId !== pendingResumeRef.current?.runId) {
          setPendingResume({ runId: page.activeRunId, cursor: page.activeStreamCursor ?? 0 });
        }
      } catch {
        /* transient — the next tick retries */
      }
    };
    const timer = setInterval(() => void check(), WAKE_POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [awaitingWake, conversationId]);
}
