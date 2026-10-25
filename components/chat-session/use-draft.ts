"use client";

import { useEffect, useRef, type ChangeEvent } from "react";

/** localStorage prefix for per-conversation composer drafts. */
const DRAFT_PREFIX = "sweatshop.draft.";

/**
 * The composer's draft persistence — unchanged mechanism, just lifted
 * out of the session: a draft is keyed by the conversation once adopted,
 * or by project + frame while fresh (so two frames never share one).
 */
export function useDraft({
  adopted,
  conversationId,
  projectId,
  frameId,
}: {
  adopted: boolean;
  conversationId: string;
  projectId?: string;
  frameId?: string;
}) {
  const draftKey =
    DRAFT_PREFIX +
    (adopted ? conversationId : `${projectId ?? "new"}${frameId ? `.${frameId}` : ""}`);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey);
    if (saved && textareaRef.current && textareaRef.current.value === "") {
      textareaRef.current.value = saved;
    }
  }, [draftKey]);
  const handleDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    if (value.trim()) {
      window.localStorage.setItem(draftKey, value);
    } else {
      window.localStorage.removeItem(draftKey);
    }
  };
  const clearDraft = () => window.localStorage.removeItem(draftKey);
  // PromptInput clears the textarea before calling onSubmit; a refused or
  // failed image send puts the text back so nothing typed is lost.
  const restoreText = (text: string) => {
    const el = textareaRef.current;
    if (!el || !text) return;
    el.value = text;
    window.localStorage.setItem(draftKey, text);
  };

  return { textareaRef, handleDraftChange, clearDraft, restoreText };
}
