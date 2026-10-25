"use client";

import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import type { UIMessage } from "ai";
import type { UseChatHelpers } from "@ai-sdk/react";
import { phaseFromMessages, type Phase } from "@/lib/thread-phase";
import { deriveOutlineTrayContext, outlineHistory } from "@/lib/outline";
import { applyLiveStates, workPRsFromMessages, type DisplayWorkPR } from "@/lib/work-prs";
import { usePRStates } from "@/lib/use-pr-states";
import { appendNewer, hasBackgroundChild, rowsToUIMessages, type ChatContextBlock } from "@/lib/chat-ui";
import { fetchChatPage } from "@/lib/chat-fetch";
import { PAGE_TAIL } from "./constants";
import type { PendingResume } from "./use-resume";

/**
 * 0022: a settled child wakes this chat by starting a turn SERVER-side
 * (or steering a live one) — the open page never sent it. While idle
 * with background work out, watch for that turn and attach to it: the
 * stored transcript (with the wake row) is swapped in, then the live
 * turn streams in like any other.
 *
 * 0075: the transcript is a WINDOW now. The header facts (phase chip,
 * work PRs, wake watch) are derived from the whole transcript
 * server-side (`context=1`, fetched on mount and whenever a turn
 * settles) and preferred over what the visible window derives — a
 * tail window may not contain the outline or PR that set the phase.
 */
export function useTranscriptContext({
  messages,
  status,
  adoptedNow,
  isBusy,
  conversationId,
  chatRef,
  pendingResumeRef,
  setPendingResume,
}: {
  messages: UIMessage[];
  status: UseChatHelpers<UIMessage>["status"];
  adoptedNow: boolean;
  isBusy: boolean;
  conversationId: string;
  chatRef: MutableRefObject<UseChatHelpers<UIMessage>>;
  pendingResumeRef: MutableRefObject<PendingResume | null>;
  setPendingResume: (value: PendingResume | null) => void;
}): {
  phase: Phase | null;
  workPRs: DisplayWorkPR[];
  outlineContext: ChatContextBlock["outline"];
  outlines: ReturnType<typeof outlineHistory>;
  awaitingWake: boolean;
} {
  const serverContext = useServerContext({
    messages,
    status,
    adoptedNow,
    conversationId,
    chatRef,
    pendingResumeRef,
    setPendingResume,
  });

  const derivedPhase = useMemo(() => phaseFromMessages(messages), [messages]);
  const derivedWorkPRs = useMemo(() => workPRsFromMessages(messages), [messages]);
  const phase = serverContext?.phase ?? derivedPhase;
  const workPRs = serverContext?.prs ?? derivedWorkPRs;
  // 0079: the composer tray's feed — same whole-transcript preference.
  const derivedOutlineContext = useMemo(() => deriveOutlineTrayContext(messages), [messages]);
  const outlineContext = serverContext?.outline ?? derivedOutlineContext;
  const backgroundOut = serverContext ? serverContext.hasBackgroundChild : hasBackgroundChild(messages);
  // 0064: an open outline review also wakes this chat (on Approve), same watch.
  const outlines = useMemo(() => outlineHistory(messages), [messages]);
  // 0052 (now 0078's work pill): ask the host for each open PR's live
  // answer (visible-tab poll; stops once merged/closed) — merged/closed
  // relabels that PR's row, unknown keeps it "open".
  const openPRUrls = useMemo(() => {
    const urls = workPRs.filter((pr) => pr.state === "open" && pr.url).map((pr) => pr.url!);
    return urls.length > 0 ? urls : null;
  }, [workPRs]);
  const prStates = usePRStates(openPRUrls);
  const shownWorkPRs = useMemo<DisplayWorkPR[]>(() => applyLiveStates(workPRs, prStates), [workPRs, prStates]);
  const awaitingWake = adoptedNow && !isBusy && (backgroundOut || outlines.openReviewId !== null);

  return { phase, workPRs: shownWorkPRs, outlineContext, outlines, awaitingWake };
}

/**
 * The context refetch runs once per settled transcript state: on
 * mount (initialMessages are ready), after each turn settles, and
 * after window appends (a settled wake turn grows the window). While
 * a turn runs there is nothing new to derive.
 */
function useServerContext({
  messages,
  status,
  adoptedNow,
  conversationId,
  chatRef,
  pendingResumeRef,
  setPendingResume,
}: {
  messages: UIMessage[];
  status: UseChatHelpers<UIMessage>["status"];
  adoptedNow: boolean;
  conversationId: string;
  chatRef: MutableRefObject<UseChatHelpers<UIMessage>>;
  pendingResumeRef: MutableRefObject<PendingResume | null>;
  setPendingResume: (value: PendingResume | null) => void;
}): ChatContextBlock | null {
  const [serverContext, setServerContext] = useState<ChatContextBlock | null>(null);
  const settledTick = status === "ready" ? messages.length : null;
  useEffect(() => {
    if (!adoptedNow || settledTick == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/x/chat?conversationId=${encodeURIComponent(conversationId)}&context=1&tail=1`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          context?: ChatContextBlock;
          activeRunId?: string | null;
          activeStreamCursor?: number | null;
        };
        if (cancelled) return;
        if (body.context) setServerContext(body.context);
        // 0077: the same response reports whether a run is live, which is
        // how a live turn becomes discoverable WITHOUT a reload (a wake
        // turn that started server-side, or this tab's own send that
        // steered into one it didn't know about) — merge whatever the
        // store already has, then hand off to the resume effect above.
        if (body.activeRunId && body.activeRunId !== pendingResumeRef.current?.runId) {
          const page = await fetchChatPage(conversationId, { tail: PAGE_TAIL });
          if (!cancelled && page) {
            const known = new Set(chatRef.current.messages.map((m) => m.id));
            const stored = rowsToUIMessages(page.rows);
            if (!stored.every((m) => known.has(m.id))) {
              chatRef.current.setMessages((prev) => appendNewer(prev, stored));
            }
          }
          if (!cancelled) {
            setPendingResume({ runId: body.activeRunId, cursor: body.activeStreamCursor ?? 0 });
          }
        }
      } catch {
        /* transient — the next settled tick retries */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chatRef/pendingResumeRef are stable refs, setPendingResume a stable setter
  }, [adoptedNow, conversationId, settledTick]);

  return serverContext;
}
