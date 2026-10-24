"use client";

import { useCallback, useState } from "react";
import type { QuestionAnswer } from "@/lib/question-form";
import { respondToInput } from "@/lib/api/input";

export interface InputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
  /** 0081: a structured ask_owner card's Submit, keyed by question id. */
  answers?: Record<string, QuestionAnswer>;
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
      const answer = answers[0];
      const freeform = answer.text?.trim();
      // A structured Submit sends `answers`; a freeform reply
      // answers a question-kind request; an option (or its
      // absence) is an approve/deny.
      const res = await respondToInput(
        answer.answers
          ? { toolCallId: answer.requestId, answers: answer.answers }
          : freeform && !answer.optionId
            ? { toolCallId: answer.requestId, answer: freeform }
            : {
                toolCallId: answer.requestId,
                approved: answer.optionId !== "deny",
                ...(freeform ? { comment: freeform } : {}),
              },
      );
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      return true;
    },
    [],
  );

  return { respond, busy, error };
}
