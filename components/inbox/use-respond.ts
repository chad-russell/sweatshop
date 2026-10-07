"use client";

import { useCallback, useState } from "react";

export interface InputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

/**
 * Answer pending human-input requests: POST /api/x/input, which resumes
 * the approval hook and resolves the pending_inputs row (0010; 0032
 * retired the eve channel-route twin).
 */
export function useRespond() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = useCallback(
    async (answers: InputAnswer[]): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const answer = answers[0];
        const freeform = answer.text?.trim();
        const res = await fetch("/api/x/input", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // A freeform reply answers a question-kind request; an
          // option (or its absence) is an approve/deny.
          body: JSON.stringify(
            freeform && !answer.optionId
              ? { toolCallId: answer.requestId, answer: freeform }
              : {
                  toolCallId: answer.requestId,
                  approved: answer.optionId !== "deny",
                  ...(freeform ? { comment: freeform } : {}),
                },
          ),
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
    [],
  );

  return { respond, busy, error };
}
