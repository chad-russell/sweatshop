"use client";

import { useCallback, useState } from "react";

export interface InputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

/**
 * Answer pending human-input requests. Eve-runtime requests go to the
 * channel route (`inputResponses`, keyed by requestId; the turn resumes
 * server-side and the mirror records `input.resolved`). 0010 chat-runtime
 * requests go to /api/x/input, which resumes the approval hook and
 * resolves the pending_inputs row.
 */
export function useRespond(sessionId: string, runtime?: "eve" | "chat") {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = useCallback(
    async (answers: InputAnswer[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        let res: Response;
        if (runtime === "chat") {
          const answer = answers[0];
          res = await fetch("/api/x/input", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              toolCallId: answer.requestId,
              approved: answer.optionId !== "deny",
              ...(answer.text ? { comment: answer.text } : {}),
            }),
          });
        } else {
          res = await fetch(`/eve/v1/session/${sessionId}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ inputResponses: answers }),
          });
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `Request failed (${res.status})`);
          return false;
        }
        return true;
      } catch {
        setError("Network error — is the server up?");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId, runtime],
  );

  return { respond, busy, error };
}
