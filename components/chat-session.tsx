"use client";

import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { ChatStatus, FileUIPart, ToolUIPart, UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { nanoid } from "nanoid";
import { RotateCcw } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
import { hasBackgroundChild, rowsToUIMessages, untilLiveTurn, type StoredRow } from "@/lib/chat-ui";
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

  const resumeRunRef = useRef<string | null>(null);
  // The callback runs at send time (never during render) and must see
  // the current knobs.
  const [transport] = useState(
    // eslint-disable-next-line react-hooks/refs -- read at send time only
    () =>
      new WorkflowChatTransport({
        api: "/api/x/chat",
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
        // A wake attach (below) resumes a turn this page never started:
        // point the reconnect at THAT run's stream (the chat id is the
        // conversation's, and the mount-time resume already used its own).
        prepareReconnectToStreamRequest: ({ api }) =>
          resumeRunRef.current ? { api: `/api/x/chat/${encodeURIComponent(resumeRunRef.current)}/stream` } : { api },
      }),
  );

  const chat = useChat({
    id: activeRunId ?? conversationId,
    resume: Boolean(activeRunId),
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
  // 0064: an open outline review also wakes this chat (on Approve), same watch.
  const outlines = useMemo(() => outlineHistory(messages), [messages]);
  const phase = useMemo(() => phaseFromMessages(messages), [messages]);
  const diffBreakdown = useMemo(() => latestDiffBreakdown(messages), [messages]);
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
    (hasBackgroundChild(messages) || outlines.openReviewId !== null);
  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  });
  useEffect(() => {
    if (!awaitingWake) return;
    let stop = false;
    const check = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/x/chat?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const body = (await res.json()) as { messages: StoredRow[]; activeRunId: string | null };
        const c = chatRef.current;
        if (stop || c.status === "submitted" || c.status === "streaming") return;
        // A live turn replays from index 0 — its persisted slices must
        // not render twice (0037 incremental persistence).
        const rows = body.messages ?? [];
        const stored = rowsToUIMessages(body.activeRunId ? untilLiveTurn(rows) : rows);
        const known = new Set(c.messages.map((m) => m.id));
        // Only act on something new: a turn in flight, or rows this
        // session has not seen (a wake turn that already finished).
        if (!body.activeRunId && stored.every((m) => known.has(m.id))) return;
        c.setMessages(stored);
        if (body.activeRunId) {
          resumeRunRef.current = body.activeRunId;
          void c.resumeStream();
        }
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
