"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { UIMessage } from "ai";
import type { UseChatHelpers } from "@ai-sdk/react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { Spinner } from "@/components/ui/spinner";
import { topInScroller } from "@/lib/anchor-scroll";
import { alignPageHead, mergeOlder, rowsToUIMessages } from "@/lib/chat-ui";
import { extendChatPageBack, fetchChatPage } from "@/lib/chat-fetch";
import { PAGE_TAIL } from "./constants";

/** Elements the scroll anchor needs: the sentinel row and the scroll
 *  container it lives in (use-stick-to-bottom's own scrollRef, read at
 *  measure time so a not-yet-attached ref never yields null). */
export interface OlderAnchor {
  sentinel: HTMLElement | null;
  scrollRef: MutableRefObject<HTMLElement | null> | null;
}

/**
 * 0075: the lazy window's older-pages control. Init-only from the
 * frame's hydration; owned here from the first load.
 */
export function useOlderMessages({
  conversationId,
  chatRef,
  messages,
  initialOlderCursor,
  initialOlderRemaining,
}: {
  conversationId: string;
  chatRef: MutableRefObject<UseChatHelpers<UIMessage>>;
  /** Only read for the anchor-restore effect's dep array — see below. */
  messages: UIMessage[];
  initialOlderCursor?: number | null;
  initialOlderRemaining?: number;
}) {
  const [olderCursor, setOlderCursor] = useState<number | null>(initialOlderCursor ?? null);
  const [olderRemaining, setOlderRemaining] = useState(initialOlderRemaining ?? 0);
  const [olderLoading, setOlderLoading] = useState(false);
  // Whether any Load-earlier fetch has happened — the sentinel shows for
  // a windowed transcript even at the start (the muted "Start of
  // conversation" line), but never on a transcript that fully hydrated.
  const [pagedOnce, setPagedOnce] = useState(false);
  const anchorRef = useRef<OlderAnchor>({ sentinel: null, scrollRef: null });
  // The pending anchor is tagged with the tick it was captured under;
  // the restore effect consumes it only on the bump that follows its
  // own prepend (see loadOlder).
  const [anchorTick, setAnchorTick] = useState(0);
  const pendingAnchorRef = useRef<{ sentinelTop: number; scrollTop: number; tick: number } | null>(null);

  /** Load the previous page: extend backwards to the oldest turn
   *  boundary in it (rows fold by turn there — a page cut mid-turn
   *  would render one turn as two messages), prepend, and keep the
   *  viewport pinned: the scroll top moves down by exactly the height
   *  the prepended content added above it. */
  const loadOlder = async () => {
    if (olderLoading || olderCursor == null) return;
    setOlderLoading(true);
    setPagedOnce(true);
    const anchor = anchorRef.current;
    const sentinel = anchor.sentinel;
    const scroll = anchor.scrollRef?.current ?? null;
    if (sentinel && scroll) {
      pendingAnchorRef.current = {
        sentinelTop: topInScroller(scroll, sentinel),
        scrollTop: scroll.scrollTop,
        tick: anchorTick,
      };
    }
    try {
      const first = await fetchChatPage(conversationId, { tail: PAGE_TAIL, before: olderCursor });
      if (!first) {
        // Transient — the cursor stays for a retry; just because the
        // fetch failed does not mean a resize stopped being pending.
        pendingAnchorRef.current = null;
        return;
      }
      const page = await extendChatPageBack(conversationId, first, PAGE_TAIL, (rows) => {
        const oldest = rows[0];
        return oldest != null && oldest.id.startsWith("t_");
      });
      setOlderCursor(page.olderCursor);
      setOlderRemaining(page.olderRemaining);
      // The extension can still be unaligned when its fetch failed
      // twice: trim the head back to the page's oldest opener so the
      // prepend never splits its first turn; a page holding none at
      // all is declined (the cursor stays for a retry). A null cursor
      // is the conversation's start — aligned by definition.
      let rows = page.rows;
      if (page.olderCursor != null && rows.length > 0 && !rows[0].id.startsWith("t_")) {
        const aligned = alignPageHead(rows);
        if (aligned == null) {
          setOlderCursor(first.olderCursor);
          setOlderRemaining(first.olderRemaining);
          pendingAnchorRef.current = null;
          return;
        }
        rows = aligned;
      }
      const older = rowsToUIMessages(rows);
      chatRef.current.setMessages((prev) => mergeOlder(prev, older));
      // The prepend and the anchor bump land in the SAME commit batch
      // (React 18 auto-batching): the restore effect below runs after
      // that DOM commit, never against the old layout — the race where
      // a messages-effect beat the prepend is gone.
      setAnchorTick((t) => t + 1);
    } finally {
      setOlderLoading(false);
    }
  };
  // The anchor restores after the prepended messages commit to the DOM:
  // the sentinel moved down by the prepended height, so the scroll top
  // follows it (scrollTop_after = scrollTop_before + ΔsentinelTop).
  // Keyed on anchorTick (bumped in the same batch as the prepend) and
  // consumed only for the bump that follows its own capture — a
  // messages change alone (slices streaming in) never consumes an
  // anchor. useLayoutEffect: restore before paint, so the pinned
  // viewport is what the user sees.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending || pending.tick + 1 !== anchorTick) return;
    pendingAnchorRef.current = null;
    const sentinel = anchorRef.current.sentinel;
    const scroll = anchorRef.current.scrollRef?.current ?? null;
    if (!sentinel || !scroll) return;
    scroll.scrollTop = pending.scrollTop + (topInScroller(scroll, sentinel) - pending.sentinelTop);
  }, [anchorTick, messages]);

  return {
    olderCursor,
    setOlderCursor,
    olderRemaining,
    setOlderRemaining,
    olderLoading,
    pagedOnce,
    anchorRef,
    loadOlder: () => void loadOlder(),
  };
}

/**
 * 0075: the load-earlier control at the top of a windowed transcript.
 * Must render inside <ConversationContent> — it takes the scroll
 * container from use-stick-to-bottom's context (the sanctioned API for
 * children of the scroller).
 */
export function OlderMessagesControl({
  remaining,
  loading,
  atStart,
  onLoad,
  anchorRef,
}: {
  /** How many older rows remain (the "~N more" hint). */
  remaining: number;
  loading: boolean;
  /** True once a page reached the start of the conversation. */
  atStart: boolean;
  onLoad: () => void;
  anchorRef: MutableRefObject<OlderAnchor>;
}) {
  const { scrollRef } = useStickToBottomContext();
  return (
    <div
      ref={(el) => {
        anchorRef.current.sentinel = el;
        anchorRef.current.scrollRef = scrollRef;
      }}
      className="flex min-h-8 items-center justify-center py-2"
    >
      {atStart ? (
        <span className="text-xs text-muted-foreground">Start of conversation</span>
      ) : loading ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3.5" aria-hidden />
          Loading…
        </span>
      ) : (
        <button
          type="button"
          onClick={onLoad}
          className="rounded text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Load earlier messages{remaining > 0 ? ` (~${remaining} more)` : ""}
        </button>
      )}
    </div>
  );
}
