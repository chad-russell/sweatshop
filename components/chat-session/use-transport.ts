"use client";

import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { ChatRoute } from "@/lib/providers/route";
import type { ViewingContext } from "@/lib/page-context";
import type { PendingResume } from "./use-resume";

/**
 * Builds the WorkflowChatTransport once per session. The callback runs
 * at send time (never during render) and must see the current knobs —
 * the route/sandbox/pending-resume refs are owned by their own hooks
 * (useRoute, useSandboxChoice, usePendingResume); conversationId,
 * projectId and pageContext are mirrored into refs here, synced
 * in an effect (post-render) the same way.
 */
export function useChatTransport({
  conversationId,
  projectId,
  pageContext,
  routeRef,
  choiceRef,
  pendingResumeRef,
}: {
  conversationId: string;
  projectId?: string;
  /** 0015: the page this chat is drawn on, read at send time. */
  pageContext?: () => ViewingContext | null;
  routeRef: MutableRefObject<{ touched: boolean; route: ChatRoute | null }>;
  choiceRef: MutableRefObject<string>;
  pendingResumeRef: MutableRefObject<PendingResume | null>;
}) {
  const conversationRef = useRef({ conversationId, projectId: projectId ?? null });
  const pageContextRef = useRef(pageContext);
  useEffect(() => {
    conversationRef.current = { conversationId, projectId: projectId ?? null };
    pageContextRef.current = pageContext;
  }, [conversationId, projectId, pageContext]);

  // 0076: the run id of THIS tab's own in-flight send (from the send
  // response header) — a dropped mid-send connection reconnects to it
  // via the index-0 replay route: it already streamed from chunk 0
  // itself, so there is nothing to skip.
  const resumeRunRef = useRef<string | null>(null);

  // The callback runs at send time (never during render) and must see
  // the current knobs.
  const [transport] = useState(
    () =>
      new WorkflowChatTransport({
        api: "/api/x/chat",
        onChatSendMessage: (response) => {
          // 0076: remember THIS tab's own run so a mid-send disconnect
          // reconnects to it (the header is the workflow run id).
          const runId = response.headers.get("x-workflow-run-id");
          resumeRunRef.current = runId ?? null;
        },
        // 0077: the own-send reconnect is only for the send in flight.
        onChatEnd: () => {
          resumeRunRef.current = null;
        },
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
          // 0015: read the page context at send time; each send's note
          // is what the page showed when Chad hit send. A panel
          // conversation's CREATING send binds to the page's project
          // (0013: chosen once, never switched) — the frame passes no
          // projectId until the conversation is adopted and hydrated.
          const viewing = pageContextRef.current?.() ?? null;
          const projectId = conversationRef.current.projectId ?? viewing?.projectId ?? null;
          return {
            body: {
              conversationId: conversationRef.current.conversationId,
              projectId,
              ...(routeRef.current.touched ? { route: routeRef.current.route } : {}),
              // Only the creating send's choice counts (server-enforced);
              // "auto" = the chat's own sandbox, the default.
              ...(choiceRef.current !== "auto" ? { sandbox: choiceRef.current } : {}),
              // 0037: creation-only server-side, like the sandbox choice.
              ...(viewing ? { context: viewing } : {}),
              messages,
              trigger,
              messageId,
            },
          };
        },
        // 0077: a tab's OWN dropped send still reconnects via the
        // index-0 replay route (resumeRunRef). Every other resume —
        // mounting onto a live turn, a wake, a steered send — is the
        // cursor-based reconnect: pendingResume names the run and the
        // raw-journal cursor `persistTurn` recorded for it, so the
        // SDK's own reconnect contract (it appends `?startIndex=` itself)
        // picks up exactly the in-progress slice, nothing replayed.
        prepareReconnectToStreamRequest: ({ api }) => {
          // A known live run (mount, wake, steer) wins: resumeRunRef may
          // still name an OLDER run this tab sent earlier, and replaying
          // that from chunk 0 would duplicate a finished turn.
          const pending = pendingResumeRef.current;
          if (pending) {
            return { api: `/api/x/chat/${encodeURIComponent(pending.runId)}/from/${pending.cursor}/stream` };
          }
          return resumeRunRef.current
            ? { api: `/api/x/chat/${encodeURIComponent(resumeRunRef.current)}/stream` }
            : { api };
        },
      }),
  );

  return transport;
}
