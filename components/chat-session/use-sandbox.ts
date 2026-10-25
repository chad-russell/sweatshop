"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus, ToolUIPart, UIMessage } from "ai";
import { getConversationSandbox } from "@/lib/api/conversations";
import { listSandboxChoices, type SandboxOption } from "@/lib/api/sandboxes";
import { SANDBOXED_TOOLS, type ConversationSandboxViewData } from "@/components/sandbox-view";

/** 0013: the fresh composer's one-time sandbox choice ("auto" = own). */
export function useSandboxChoice() {
  const [sandboxChoice, setSandboxChoice] = useState("auto");
  const [sandboxes, setSandboxes] = useState<SandboxOption[]>([]);
  const loadSandboxes = async () => {
    const choices = await listSandboxChoices();
    if (choices) setSandboxes(choices);
  };

  // Turn the choice into a request field on every send. The ref is
  // synced in an effect (post-render); sends can only happen after
  // mount, so the value is always current when a request fires.
  const choiceRef = useRef(sandboxChoice);
  useEffect(() => {
    choiceRef.current = sandboxChoice;
  }, [sandboxChoice]);

  return {
    sandboxChoice,
    setSandboxChoice,
    sandboxes,
    loadSandboxes: () => void loadSandboxes(),
    choiceRef,
  };
}

/**
 * 0011: the sandbox read-model — which sandbox each sandboxed call ran
 * in and where the next one would. The call rows are written by the
 * server when a call acquires its sandbox, so refetch whenever a
 * sandboxed tool part appears or changes state (not per streamed token).
 */
export function useSandboxView({
  started,
  conversationId,
  messages,
  status,
}: {
  started: boolean;
  conversationId: string;
  messages: UIMessage[];
  status: ChatStatus;
}): ConversationSandboxViewData | null {
  const [sandboxView, setSandboxView] = useState<ConversationSandboxViewData | null>(null);
  const sandboxSignature = useMemo(
    () =>
      messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type.startsWith("tool-") && SANDBOXED_TOOLS.has(p.type.slice(5)))
        .map((p) => `${(p as ToolUIPart).toolCallId}:${(p as ToolUIPart).state}`)
        .join("|") + `#${status === "ready" ? "r" : "b"}`,
    [messages, status],
  );
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    void (async () => {
      // chips and the state label are best-effort
      const next = await getConversationSandbox(conversationId);
      if (next && !cancelled) setSandboxView(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [started, conversationId, sandboxSignature]);

  return sandboxView;
}
