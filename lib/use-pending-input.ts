"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 0010 human input, transcript side: the /api/x/input plumbing the
 * approval cards in components/chat-cards/approvals.tsx each hand-rolled.
 * GET returns `{evidence}` — the pending_inputs row's parsed card (0081)
 * — which each card validates through its own predicate (isAskOwnerCard,
 * isOutlineCard, …); POST answers the row and resumes the approval hook.
 */

const POLL_MS = 3_000;

/**
 * Fetch GET /api/x/input once, then poll every 3 s, until `accept`
 * recognizes the row's evidence as this card's data — then stop and
 * hold it (`T` is exactly what the predicate narrowing promises; the
 * cast lives here so no call site needs one). `enabled: false` (the
 * part already resolved) parks the poll without data. Transient
 * failures are swallowed — the next tick retries.
 */
export function usePendingInputCard<T>(
  toolCallId: string,
  accept: (evidence: unknown) => boolean,
  enabled = true,
): T | null {
  const [card, setCard] = useState<T | null>(null);
  useEffect(() => {
    if (card || !enabled) return;
    let stop = false;
    const load = async () => {
      const res = await fetch(`/api/x/input?toolCallId=${encodeURIComponent(toolCallId)}`).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { evidence?: unknown } | null;
      if (!stop && accept(body?.evidence)) setCard(body?.evidence as T);
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [toolCallId, card, enabled, accept]);
  return card;
}

/**
 * POST an answer to /api/x/input — `{approved: boolean}` for approvals
 * (0010), `{answer}` or a 0081 structured `{answers}` for questions.
 * `busy` spans the request; `answered` flips once a post lands ok, the
 * optimistic signal for cards whose part output never changes
 * (PendingPRApproval, AcceptOutlineCard). Cards that read the answer
 * from the tool part's own output state derive `answered` there and
 * ignore this one.
 */
export function useAnswerPendingInput(toolCallId: string) {
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const post = useCallback(
    async (payload: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await fetch("/api/x/input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolCallId, ...payload }),
        });
        if (res.ok) setAnswered(true);
        return res.ok;
      } finally {
        setBusy(false);
      }
    },
    [toolCallId],
  );
  return { answered, busy, post };
}
