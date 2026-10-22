"use client";

import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { ChatStatus, FileUIPart, ToolUIPart, UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { nanoid } from "nanoid";
import { RotateCcw } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ComposerAddButton, ComposerAttachments, attachmentErrorMessage } from "@/components/composer-attachments";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from "@/lib/attachment-ref";
import { OutlineViewProvider, type OutlineView } from "@/components/outline-card";
import { applyPRState, phaseFromMessages, type Phase } from "@/lib/thread-phase";
import { outlineHistory } from "@/lib/outline";
import { latestDiffBreakdown, type DiffBreakdown } from "@/lib/diff-breakdown";
import { usePRStates } from "@/lib/use-pr-states";
import { Spinner } from "@/components/ui/spinner";
import { SweatshopLogo } from "@/components/sweatshop-logo";
import type { ChatRoute } from "@/lib/providers/route";
import type { ViewingContext } from "@/lib/page-context";
import { topInScroller } from "@/lib/anchor-scroll";
import {
  alignPageHead,
  appendNewer,
  hasBackgroundChild,
  mergeOlder,
  replaceLiveTurn,
  rowsToUIMessages,
  type ChatContextBlock,
} from "@/lib/chat-ui";
import { extendChatPageBack, fetchChatPage } from "@/lib/chat-fetch";
import { CHAT_STREAM_THROTTLE_MS } from "@/lib/chat-stream-throttle";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import {
  SANDBOXED_TOOLS,
  SandboxViewProvider,
  type ConversationSandboxViewData,
} from "@/components/sandbox-view";
import { ChatMessageView } from "./chat-cards/message-view";

export { ChatMessageView } from "./chat-cards/message-view";

/**
 * 0015 Phase 3 — the frame-independent chat session: transcript,
 * composer, transport, approvals and send-time knobs (model, sandbox
 * choice), everything a chat is regardless of where it is drawn. The
 * frames (components/chat.tsx page frame, the 0015 agent panel) own
 * only chrome: header, pickers, URL behaviour, new-chat.
 *
 * The runtime is unchanged from 0010 Phase 4: one WorkflowAgent turn
 * per message streamed through WorkflowChatTransport; a send that
 * creates the conversation reports back through `onAdopted` (the page
 * frame rewrites the URL; the panel stores the id). While a turn runs,
 * sending queues a steer instead of a new turn.
 */

/** localStorage key for the chosen model (default for new conversations). */

/** localStorage prefix for per-conversation composer drafts. */
const DRAFT_PREFIX = "sweatshop.draft.";

/** How often an idle chat with background work out checks for its wake. */
const WAKE_POLL_MS = 5000;
/** 0076: while a turn this tab never started is live elsewhere, poll for
 * its newly persisted slices. 2s keeps a reloaded tab within a slice or
 * two of the live stream without hammering the store. */
const SLICE_POLL_MS = 2000;

/** 0075: rows fetched per page (hydration window, wake-poll tail, and
 *  the load-earlier step — one screenful of turns each). */
const PAGE_TAIL = 150;

/** Elements the scroll anchor needs: the sentinel row and the scroll
 *  container it lives in (use-stick-to-bottom's own scrollRef, read at
 *  measure time so a not-yet-attached ref never yields null). */
interface OlderAnchor {
  sentinel: HTMLElement | null;
  scrollRef: MutableRefObject<HTMLElement | null> | null;
}

/**
 * 0075: the load-earlier control at the top of a windowed transcript.
 * Must render inside <ConversationContent> — it takes the scroll
 * container from use-stick-to-bottom's context (the sanctioned API for
 * children of the scroller).
 */
function OlderMessagesControl({
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


/** A running sandbox the composer can attach to (0013 picker). */
export interface SandboxOption {
  id: string;
  status: string;
  ownerKind: string;
  ownerId: string;
  /** Chat title or machine run name. */
  ownerLabel: string;
  projectId: string | null;
  projectName: string | null;
  lastUsedAt: number;
  chats: number;
  ref: string;
}

/** What the session tells its frame each render (header chrome, fresh-mode). */
export interface ChatSessionState {
  conversationId: string;
  /** True when the frame opened an existing conversation (`/c/<id>`). */
  adopted: boolean;
  /** A first send has happened — the conversation exists server-side. */
  started: boolean;
  /** Nothing sent yet on a new conversation (the machine-target moment). */
  fresh: boolean;
  /** 0021: the conversation's own route (null = project / global default). */
  route: ChatRoute | null;
  selectRoute: (route: ChatRoute | null) => void;
  sandboxChoice: string;
  setSandboxChoice: (choice: string) => void;
  sandboxes: SandboxOption[];
  loadSandboxes: () => void;
  sandboxView: ConversationSandboxViewData | null;
  /** A turn is running (submitted/streaming). */
  busy: boolean;
  status: ChatStatus;
  /** Forget the composer draft (a run start consumed the text). */
  clearDraft: () => void;
  /** 0041: the work phase derived from the transcript (plan → build → PR). */
  phase: Phase | null;
  /** 0059: the newest create_pr call's diff breakdown, for the header chip. */
  diffBreakdown: DiffBreakdown | null;
  /** The live transcript — the work chip derives its live child set
   *  from it (lib/chat-ui.ts's backgroundChildIds). */
  messages: UIMessage[];
}

/** A frame's takeover of the fresh composer (the page frame's machine
 *  target, 0012). Everything is optional; absent means a plain chat. */
export interface FreshComposerMode {
  emptyState?: ReactNode;
  placeholder?: string;
  /** Rendered in the composer footer while fresh (the target picker). */
  footer?: ReactNode;
  /** Handle a fresh submit; return true when consumed (not sent as a chat). */
  onSubmit?: (text: string) => boolean;
  /** Extra busy state for the submit button (a run is starting). */
  busy?: boolean;
  /** An extra error line under the composer. */
  error?: string | null;
}

/** What a frame can drive on the session (New chat, focus). */
export interface ChatSessionController {
  reset: () => void;
  focus: () => void;
}

/** True while a turn is running but no answer text has started. */
function isThinking(status: ChatStatus, messages: readonly UIMessage[]) {
  if (status === "submitted") return true;
  if (status !== "streaming") return false;
  const last = messages[messages.length - 1];
  return !(
    last?.role === "assistant" &&
    last.parts.some((part) => part.type === "text" && part.text)
  );
}

/** A live turn owns the transcript — history merges wait for it. (A
 *  helper, not inline compares: TS narrowing of `c.status` survives
 *  `await`, and the status may genuinely change mid-fetch.) */
const busyNow = (c: { status: ChatStatus }) => c.status === "submitted" || c.status === "streaming";

/** The AI SDK's send shape requires `text`, yet its runtime adds a text part
 *  only when one is given — so an image-only send omits it (an empty-string
 *  text would become an empty text part). */
function sendPayload(text: string, files: FileUIPart[], metadata?: unknown) {
  return {
    ...(text ? { text } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(metadata ? { metadata } : {}),
  } as { text: string; files?: FileUIPart[]; metadata?: unknown };
}

/**
 * The frame-independent chat session. Drawn by the page frame
 * (components/chat.tsx) and, from 0015 Phase 5, the agent panel.
 */
export function ChatSession({
  conversationId: initialConversationId,
  initialMessages,
  activeRunId,
  projectId,
  initialRoute,
  olderCursor: initialOlderCursor,
  olderRemaining: initialOlderRemaining,
  frameId,
  header,
  freshComposer,
  composerTools,
  onAdopted,
  onAddressable,
  pageContext,
  skill,
  className,
  ref,
}: {
  conversationId?: string;
  initialMessages?: UIMessage[];
  activeRunId?: string | null;
  projectId?: string;
  /** 0021: the stored conversation route (init-only). */
  initialRoute?: ChatRoute | null;
  /** 0075: the hydrated tail window's older-page cursor and remaining
   *  count — init-only; the sentinel starts from these and owns them
   *  from the first Load earlier messages on. */
  olderCursor?: number | null;
  olderRemaining?: number;
  /** Names this frame's drafts (e.g. "panel") so two frames never share one. */
  frameId?: string;
  /** The frame's chrome, rendered above the transcript with the knobs. */
  header?: (state: ChatSessionState) => ReactNode;
  /** The frame's takeover of the fresh composer (the machine target). */
  freshComposer?: (state: ChatSessionState) => FreshComposerMode | undefined;
  /** The frame's controls inside the composer footer (model, sandbox). */
  composerTools?: (state: ChatSessionState) => ReactNode;
  /** Fired once when a send adopts the client-generated conversation id
   *  (the turn may still be live — do not move to another route here). */
  onAdopted?: (conversationId: string) => void;
  /** Fired once, after the creating turn settles: the server now holds
   *  the whole turn, so a frame may navigate to the conversation's own
   *  address (a remount there loses nothing). */
  onAddressable?: (conversationId: string) => void;
  /** 0015: the page this chat is drawn on, read at send time — each send
   *  carries it as the turn's viewing note ("this"). Absent = no note. */
  pageContext?: () => ViewingContext | null;
  /** 0039: the skill the creating send binds (null = plain chat). */
  skill?: string | null;
  className?: string;
  ref?: Ref<ChatSessionController>;
}) {
  const mounted = useMounted();

  // Landing pages hold no conversation yet — the id is client-generated
  // and adopted by the server on the first send.
  const [freshId] = useState(() => `c_${nanoid()}`);
  const conversationId = initialConversationId ?? freshId;
  const adopted = Boolean(initialConversationId);
  // 0015: a session that started fresh is adopted the moment its first
  // send creates the conversation server-side. From then on it behaves
  // adopted (mark-seen, harness links, frame state) WITHOUT remounting
  // or changing its chat id — the client-generated id IS the server id,
  // and killing the useChat instance mid-turn would drop the stream
  // (the transport's reconnect only works while the instance lives).
  const [selfAdopted, setSelfAdopted] = useState(false);
  const adoptedNow = adopted || selfAdopted;

  // 0021: per conversation, not sticky across chats — a fresh chat
  // starts on the default (which /settings or the project decides). Sent
  // only once Chad picks, so the server's stored route is never clobbered.
  const [route, setRoute] = useState<ChatRoute | null>(initialRoute ?? null);
  const [routeTouched, setRouteTouched] = useState(false);
  const selectRoute = (next: ChatRoute | null) => {
    setRoute(next);
    setRouteTouched(true);
  };

  // 0013: the fresh composer's one-time sandbox choice ("auto" = own).
  const [sandboxChoice, setSandboxChoice] = useState("auto");
  const [sandboxes, setSandboxes] = useState<SandboxOption[]>([]);
  const loadSandboxes = async () => {
    try {
      const res = await fetch("/api/x/sandboxes");
      if (res.ok) setSandboxes(((await res.json()) as { sandboxes: SandboxOption[] }).sandboxes);
    } catch {
      // the dropdown just shows fewer options
    }
  };

  // Turn the knobs into request fields on every send. The refs are
  // synced in an effect (post-render); sends can only happen after
  // mount, so the values are always current when a request fires.
  const routeRef = useRef<{ touched: boolean; route: ChatRoute | null }>({ touched: false, route });
  const choiceRef = useRef(sandboxChoice);
  const conversationRef = useRef({ conversationId, projectId: projectId ?? null });
  const pageContextRef = useRef(pageContext);
  const skillRef = useRef(skill ?? null);
  useEffect(() => {
    routeRef.current = { touched: routeTouched, route };
    choiceRef.current = sandboxChoice;
    conversationRef.current = { conversationId, projectId: projectId ?? null };
    pageContextRef.current = pageContext;
    skillRef.current = skill ?? null;
  }, [route, routeTouched, sandboxChoice, conversationId, projectId, pageContext, skill]);

  // 0076: the run id of THIS tab's own in-flight send (from the send
  // response header) — the only stream a reconnect may attach now.
  const resumeRunRef = useRef<string | null>(null);
  // The callback runs at send time (never during render) and must see
  // the current knobs.
  const [transport] = useState(
    // eslint-disable-next-line react-hooks/refs -- read at send time only
    () =>
      new WorkflowChatTransport({
        api: "/api/x/chat",
        onChatSendMessage: (response) => {
          // 0076: remember THIS tab's own run so a mid-send disconnect
          // reconnects to it (the header is the workflow run id).
          const runId = response.headers.get("x-workflow-run-id");
          resumeRunRef.current = runId ?? null;
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
              ...(skillRef.current ? { skill: skillRef.current } : {}),
              ...(viewing ? { context: viewing } : {}),
              messages,
              trigger,
              messageId,
            },
          };
        },
        // 0076: reconnects only happen for runs THIS tab started
        // (its own stream dropped mid-flight); reloaded tabs never
        // attach a live run's stream (see useChat below), so the
        // durable journal is never replayed on load.
        prepareReconnectToStreamRequest: ({ api }) =>
          resumeRunRef.current ? { api: `/api/x/chat/${encodeURIComponent(resumeRunRef.current)}/stream` } : { api },
      }),
  );

  // 0076: NO resume on mount. Mounting with resume:true made the transport
  // attach the run's durable stream, which the engine can only replay
  // from chunk 0 — the multi-second "world replay" on every reload of a
  // busy chat. Live turns this tab didn't start render from persisted
  // slices (initialMessages + the slice poll below); the tab that
  // started a turn streams it as always.
  const chat = useChat({
    id: activeRunId ?? conversationId,
    transport,
    // Long turns stream thousands of chunks (reasoning deltas
    // token-by-token); without a throttle every chunk re-renders the
    // whole transcript and the page seizes (2026-10-10 review thread).
    throttle: CHAT_STREAM_THROTTLE_MS,
    ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages } : {}),
  });

  const status = mounted ? chat.status : "ready";
  const isBusy = status === "submitted" || status === "streaming";
  const messages = chat.messages;

  // 0022: a settled child wakes this chat by starting a turn SERVER-side
  // (or steering a live one) — the open page never sent it. While idle
  // with background work out, watch for that turn and attach to it: the
  // stored transcript (with the wake row) is swapped in, then the live
  // turn streams in like any other.
  // 0075: the transcript is a WINDOW now. The header facts (phase
  // chip, diff breakdown, wake watch) are derived from the whole
  // transcript server-side (`context=1`, fetched on mount and whenever
  // a turn settles) and preferred over what the visible window derives
  // — a tail window may not contain the outline or PR that set the
  // phase.
  const [serverContext, setServerContext] = useState<ChatContextBlock | null>(null);
  const derivedPhase = useMemo(() => phaseFromMessages(messages), [messages]);
  const derivedDiffBreakdown = useMemo(() => latestDiffBreakdown(messages), [messages]);
  const phase = serverContext?.phase ?? derivedPhase;
  const diffBreakdown = serverContext?.diffBreakdown ?? derivedDiffBreakdown;
  const backgroundOut = serverContext ? serverContext.hasBackgroundChild : hasBackgroundChild(messages);
  // 0064: an open outline review also wakes this chat (on Approve), same watch.
  const outlines = useMemo(() => outlineHistory(messages), [messages]);
  // 0052: while the derived phase is an open PR, ask the host what it
  // says now (visible-tab poll; stops once merged/closed) — merged/
  // closed relabels the chip, unknown keeps the derived label. The
  // PR URL stays the link.
  const prUrls = useMemo(
    () => (phase?.kind === "pr-open" && phase.url ? [phase.url] : null),
    [phase],
  );
  const prStates = usePRStates(prUrls);
  const shownPhase = prUrls ? applyPRState(phase, prStates[prUrls[0]] ?? null) : phase;
  const awaitingWake =
    (adopted || selfAdopted) &&
    !isBusy &&
    (backgroundOut || outlines.openReviewId !== null);
  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  });
  // A foreign live turn. The mount prop (activeRunId) only EVER says
  // "was live at hydration" — it never clears, so it may not gate a
  // poll alone (0076 review finding 4: a settled run would be polled
  // forever). foreignLive is set by either poll seeing a live run in
  // the store and cleared the moment the store reports none; the prop
  // merely seeds the FIRST poll so a page that hydrates mid-turn
  // starts watching immediately.
  const [foreignLive, setForeignLive] = useState(Boolean(activeRunId));

  // The context refetch runs once per settled transcript state: on
  // mount (initialMessages are ready), after each turn settles, and
  // after window appends (a settled wake turn grows the window). While
  // a turn runs there is nothing new to derive.
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
        const body = (await res.json()) as { context?: ChatContextBlock; activeRunId?: string | null };
        if (cancelled) return;
        if (body.context) setServerContext(body.context);
        // 0076 followup: the same response reports whether a run is live,
        // which is how a live turn becomes discoverable WITHOUT a reload
        // (a steered send's empty stream just settled this tab, or the
        // tab sat idle while a wake started a turn) — it feeds the slice
        // poll below.
        setForeignLive(Boolean(body.activeRunId));
      } catch {
        /* transient — the next settled tick retries */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptedNow, conversationId, settledTick]);
  useEffect(() => {
    if (!awaitingWake) return;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const c = chatRef.current;
        if (busyNow(c)) return;
        // The newest tail page, walked back until it ALIGNS with the
        // window: its first row is one we show, or a turn opener we
        // don't. Alignment is what appendNewer needs — a page starting
        // mid-fold could otherwise duplicate text already on screen.
        const known = new Set(c.messages.map((m) => m.id));
        const windowHead = c.messages[0]?.id ?? null;
        let page = await fetchChatPage(conversationId, { tail: PAGE_TAIL });
        if (!page || stop) return;
        if (page.rows[0] != null && !known.has(page.rows[0].id)) {
          // 0076 finding 1: the walk must stop at the WINDOW HEAD (by
          // id) or a t_ row — a page that strides past the head without
          // landing on it spans below the window and corrupts merges.
          // Stopping AT the head yields a page whose first row is known.
          page = await extendChatPageBack(conversationId, page, PAGE_TAIL, (rows) => {
            const first = rows[0];
            return first != null && (first.id === windowHead || known.has(first.id) || first.id.startsWith("t_"));
          });
        }
        // A send may have started while the fetches were out — appending
        // stored history under an optimistic send would misorder the turn.
        if (stop || busyNow(c)) return;
        const firstRow = page.rows[0];
        const aligned = firstRow != null && (known.has(firstRow.id) || firstRow.id.startsWith("t_"));
        if (!page.activeRunId) {
          // Idle: merge, never replace — appendNewer is gated at turn
          // boundaries, so even a tail the failed extension left
          // unaligned can only append whole turns the window has never
          // seen; the older pages the user already loaded stay put.
          const stored = rowsToUIMessages(page.rows);
          if (stored.every((m) => known.has(m.id))) return;
          c.setMessages((prev) => appendNewer(prev, stored));
          return;
        }
        // 0076: a live turn to attach — but never via the stream. The
        // journal can only be replayed from chunk 0, so a reloaded tab
        // views the turn by its PERSISTED SLICES instead: append them
        // now and let the slice poll below keep it current until the
        // run settles. (The aligned flag is now only appendNewer's gate
        // — an unaligned page simply waits for the next tick, which
        // re-extends from the known set; nothing is replaced.)
        if (!aligned) return;
        const stored = rowsToUIMessages(page.rows);
        if (stored.every((m) => known.has(m.id))) return;
        // The turn is live: its fold re-ids and grows every poll, so
        // replace it (keep history up to its opener) rather than append.
        c.setMessages((prev) => replaceLiveTurn(prev, stored));
        setForeignLive(true);
      } catch {
        /* transient — the next tick retries */
      }
    };
    const timer = setInterval(() => void check(), WAKE_POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [awaitingWake, conversationId]);

  // ── 0076: the live-run slice poll ──────────────────────────────────
  // While a run is live for this conversation but THIS tab is not
  // streaming it (a reload mid-turn, or a wake turn that started
  // server-side), poll the store for newly persisted slices and append
  // them. The poll stops the moment the run settles (the wake effect
  // and the settled context refetch take over) or this tab starts
  // streaming itself.
  const liveElsewhere = foreignLive && !isBusy && status === "ready";
  useEffect(() => {
    if (!adoptedNow || !liveElsewhere) return;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const c = chatRef.current;
        if (busyNow(c)) return;
        const known = new Set(c.messages.map((m) => m.id));
        const windowHead = c.messages[0]?.id ?? null;
        let page = await fetchChatPage(conversationId, { tail: PAGE_TAIL });
        if (!page || stop) return;
        if (page.rows[0] != null && !known.has(page.rows[0].id)) {
          // 0076 finding 1: stop at the window head or a t_ row (above).
          page = await extendChatPageBack(conversationId, page, PAGE_TAIL, (rows) => {
            const first = rows[0];
            return first != null && (first.id === windowHead || known.has(first.id) || first.id.startsWith("t_"));
          });
        }
        if (stop || busyNow(c)) return;
        const firstRow = page.rows[0];
        const aligned = firstRow != null && (known.has(firstRow.id) || firstRow.id.startsWith("t_"));
        if (!aligned) return;
        const stored = rowsToUIMessages(page.rows);
        if (stored.every((m) => known.has(m.id))) return;
        // Growing live fold: replace, never append (see wake poll).
        c.setMessages((prev) => replaceLiveTurn(prev, stored));
        setForeignLive(Boolean(page.activeRunId));
      } catch {
        /* transient — the next tick retries */
      }
    };
    const timer = setInterval(() => void check(), SLICE_POLL_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [adoptedNow, liveElsewhere, conversationId]);

  // ── 0075: the lazy window's older-pages control ────────────────────────
  // Init-only from the frame's hydration; owned here from the first load.
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

  // 0011: the sandbox read-model — which sandbox each sandboxed call ran
  // in and where the next one would. The call rows are written by the
  // server when a call acquires its sandbox, so refetch whenever a
  // sandboxed tool part appears or changes state (not per streamed token).
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
  // A chat reached via "/" is not "adopted" but exists server-side from
  // its first send, so key on having messages, not on the landing route.
  const started = adopted || messages.length > 0;
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/sandbox`, {
          cache: "no-store",
        });
        if (res.ok && !cancelled) {
          const next = (await res.json()) as ConversationSandboxViewData;
          setSandboxView(next);
        }
      } catch {
        // chips and the state label are best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [started, conversationId, sandboxSignature]);

  // A send that created the conversation reports to the frame exactly
  // once (the page frame rewrites the URL and refreshes the sidebar).
  const adoptedRef = useRef(false);
  const onAdoptedRef = useRef(onAdopted);
  useEffect(() => {
    onAdoptedRef.current = onAdopted;
  }, [onAdopted]);
  useEffect(() => {
    if (adopted || messages.length === 0) return;
    if (adoptedRef.current) return;
    adoptedRef.current = true;
    setSelfAdopted(true);
    onAdoptedRef.current?.(conversationId);
  }, [adopted, conversationId, messages.length]);

  // ...and, separately, once that creating turn has SETTLED: only then may
  // the frame give the session its durable address. A frame whose address
  // is a different route (the page frame's / → /c/<id>) remounts on the
  // next router.refresh(); mid-turn that drops the live stream and mounts
  // a snapshot taken before the turn wrote anything — the blank "new
  // chat" Chad saw after a first send (2026-10-07).
  const addressedRef = useRef(false);
  const onAddressableRef = useRef(onAddressable);
  useEffect(() => {
    onAddressableRef.current = onAddressable;
  }, [onAddressable]);
  useEffect(() => {
    if (adopted || !selfAdopted || isBusy || addressedRef.current) return;
    addressedRef.current = true;
    onAddressableRef.current?.(conversationId);
  }, [adopted, selfAdopted, isBusy, conversationId]);

  // Opening a thread marks it read (visible + focused only) — including
  // a fresh session after its first send created the conversation.
  useMarkSeen(adoptedNow ? conversationId : null, `${messages.length}:${isBusy ? "busy" : status}`);

  // The last thing Chad sent — its text and uploaded images — for Retry.
  const lastUserSend = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      const files = message.parts.filter((part): part is FileUIPart => part.type === "file");
      return text || files.length > 0 ? { text, files } : null;
    }
    return null;
  }, [messages]);

  // ── Draft persistence (unchanged mechanism) ───────────────────────────
  const fresh = !adopted && messages.length === 0;
  const draftKey =
    DRAFT_PREFIX +
    (adopted
      ? conversationId
      : `${projectId ?? "new"}${frameId ? `.${frameId}` : ""}`);
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

  // ── The frame's fresh-composer takeover (page frame: machine target) ──
  const state: ChatSessionState = {
    conversationId,
    adopted: adoptedNow,
    started,
    fresh,
    route,
    selectRoute,
    sandboxChoice,
    setSandboxChoice,
    sandboxes,
    loadSandboxes: () => void loadSandboxes(),
    sandboxView,
    busy: isBusy,
    status,
    clearDraft: () => window.localStorage.removeItem(draftKey),
    phase: shownPhase,
    diffBreakdown,
    messages,
  };

  // 0064: Quote for the outline card, same mechanism.
  const outlineView = useMemo<OutlineView>(() => ({
    history: outlines,
    conversationId,
    projectId: projectId ?? null,
    quote: (selection) => {
      const el = textareaRef.current;
      if (!el) return;
      const before = el.value.trimEnd();
      const quoted = `${selection.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
      el.value = `${before ? `${before}\n\n` : ""}${quoted}`;
      if (el.value.trim()) window.localStorage.setItem(draftKey, el.value);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
  }), [outlines, draftKey, conversationId, projectId]);
  const freshMode = fresh ? freshComposer?.(state) : undefined;

  // 0042: images upload first (each becomes an attachment id), then the
  // send carries them as file parts pointing at the serving route.
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // A refusal notice is a passing remark, not state: it clears itself.
  useEffect(() => {
    if (!composerNotice) return;
    const timer = setTimeout(() => setComposerNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [composerNotice]);

  // PromptInput clears the textarea before calling onSubmit; a refused or
  // failed image send puts the text back so nothing typed is lost.
  const restoreText = (text: string) => {
    const el = textareaRef.current;
    if (!el || !text) return;
    el.value = text;
    window.localStorage.setItem(draftKey, text);
  };

  const uploadImages = (files: FileUIPart[]): Promise<FileUIPart[]> =>
    Promise.all(
      files.map(async (file) => {
        const blob = await (await fetch(file.url)).blob();
        const form = new FormData();
        form.set("file", new File([blob], file.filename ?? "image", { type: blob.type }));
        const res = await fetch("/api/x/attachments", { method: "POST", body: form });
        const body = (await res.json().catch(() => ({}))) as { error?: string; url?: string; mediaType?: string };
        if (!res.ok || !body.url || !body.mediaType) {
          throw new Error(body.error ?? `upload failed (${res.status})`);
        }
        return { type: "file" as const, mediaType: body.mediaType, url: body.url, filename: file.filename };
      }),
    );

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text?.trim() ?? "";
    const images = message.files ?? [];
    if (!text && images.length === 0) return;
    setComposerNotice(null);
    if (images.length === 0 && freshMode?.onSubmit?.(text)) return;
    if (images.length > 0 && isBusy) {
      // Steers are text-only: refuse, keep the images and the text.
      setComposerNotice("Images can't be added while a turn is running — wait for it to finish.");
      restoreText(text);
      throw new Error("images while busy");
    }
    let files: FileUIPart[] = [];
    if (images.length > 0) {
      setUploading(true);
      try {
        files = await uploadImages(images);
      } catch (err) {
        setComposerNotice(`Couldn't upload the image: ${err instanceof Error ? err.message : "unknown error"}`);
        restoreText(text);
        throw err; // PromptInput keeps the thumbnails when onSubmit throws
      } finally {
        setUploading(false);
      }
    }
    window.localStorage.removeItem(draftKey);
    if (isBusy) {
      // A live turn: queue a steer (drained between the turn's slices).
      void fetch("/api/x/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, text }),
      });
      return;
    }
    // The optimistic user message carries the viewing context as
    // metadata, so the chip shows live (a reload reads the row's).
    const viewing = pageContextRef.current?.() ?? null;
    void chat.sendMessage(
      sendPayload(text, files, viewing ? { viewing } : undefined),
    );
  };

  const handleStop = async () => {
    chat.stop();
    await fetch("/api/x/chat/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }).catch(() => undefined);
  };

  const handleRetry = () => {
    if (!lastUserSend) return;
    void chat.sendMessage(sendPayload(lastUserSend.text, lastUserSend.files));
  };

  useImperativeHandle(
    ref,
    () => ({
      reset: () => chat.setMessages([]),
      focus: () => textareaRef.current?.focus(),
    }),
    [chat],
  );

  return (
    <div className={cn("flex min-h-0 w-full flex-col", className)}>
      {header ? header(state) : null}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {/* 0075: the window's older-pages control — only for a
              transcript that hydrated as a tail window (or already
              paged once). Must sit inside the scroller's content for
              the scroll anchor to measure it. */}
          {adoptedNow && started && (olderCursor != null || pagedOnce) && (
            <OlderMessagesControl
              remaining={olderRemaining}
              loading={olderLoading}
              atStart={olderCursor == null && !olderLoading}
              onLoad={() => void loadOlder()}
              anchorRef={anchorRef}
            />
          )}
          {messages.length === 0 && status === "ready" && !chat.error && (
            freshMode?.emptyState ?? (
              <ConversationEmptyState
                icon={<SweatshopLogo className="size-10 text-primary" />}
                title="sweatshop"
                description="A conversation with your agent. Say anything to begin."
              />
            )
          )}
          <SandboxViewProvider value={sandboxView}>
          <OutlineViewProvider value={outlineView}>
          {messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              conversationId={adoptedNow ? conversationId : null}
            />
          ))}
          </OutlineViewProvider>
          </SandboxViewProvider>
          {isThinking(status, messages) && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground" role="status">
              <Spinner className="size-4" />
              {isBusy && messages.some((m) => m.parts.some((p) => p.type.startsWith("tool-")))
                ? "Working…"
                : "Thinking…"}
            </div>
          )}
          {chat.error && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 py-2 text-sm text-destructive"
            >
              <span className="min-w-0 flex-1 break-words">{chat.error.message}</span>
              {lastUserSend && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 pointer-coarse:h-10 text-xs font-medium transition-colors hover:bg-destructive/10"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  Retry
                </button>
              )}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="w-full px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4">
        <PromptInput
          onSubmit={handleSubmit}
          className="composer"
          accept="image/*"
          multiple
          maxFiles={MAX_IMAGES_PER_MESSAGE}
          maxFileSize={MAX_IMAGE_BYTES}
          onError={(err) => setComposerNotice(attachmentErrorMessage(err.code))}
        >
          <ComposerAttachments dimmed={uploading} />
          <PromptInputTextarea
            ref={textareaRef}
            onChange={handleDraftChange}
            placeholder={
              isBusy
                ? "Steer the running turn…"
                : freshMode?.placeholder ?? "Message sweatshop…"
            }
            autoFocus
          />
          <PromptInputFooter>
            <PromptInputTools className="flex-1 overflow-hidden">
              <ComposerAddButton disabled={isBusy} />
              {fresh ? freshMode?.footer : null}
              {composerTools?.(state)}
            </PromptInputTools>
            <PromptInputSubmit
              status={freshMode?.busy ? "submitted" : status}
              onStop={() => void handleStop()}
              disabled={uploading}
            >
              {uploading ? <Spinner className="size-4" /> : undefined}
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
        {composerNotice && (
          <p role="alert" className="pt-2 text-sm text-destructive">
            {composerNotice}
          </p>
        )}
        {freshMode?.error && (
          <p role="alert" className="pt-2 text-sm text-destructive">
            {freshMode.error}
          </p>
        )}
      </div>
    </div>
  );
}
