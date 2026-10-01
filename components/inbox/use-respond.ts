"use client";

import { useCallback, useState } from "react";

export interface InputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

/**
 * Answer pending human-input requests straight on eve's channel route
 * (`inputResponses`, keyed by requestId). The turn resumes server-side;
 * the mirror then records `input.resolved`, which clears the request from
 * the Inbox on the next refresh.
 */
export function useRespond(sessionId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = useCallback(
    async (answers: InputAnswer[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/eve/v1/session/${sessionId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inputResponses: answers }),
        });
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
    [sessionId],
  );

  return { respond, busy, error };
}
