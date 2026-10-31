"use client";

import type { ChatStatus, FileUIPart, UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { nanoid } from "nanoid";
import { RotateCcw } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
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
import { OutlineTray } from "@/components/outline-tray";
import type { ChatRoute } from "@/lib/providers/route";
import type { ViewingContext } from "@/lib/page-context";
import { cancelChat, steerChat, uploadAttachment } from "@/lib/api/chat";
import { fetchAttachableSkills, type AttachableSkill } from "@/lib/api/skills-catalog";
import { AttachedSkillChips, SkillPicker } from "@/components/skill-picker";
import { MAX_ATTACHED_SKILLS } from "@/lib/skills/sources";
import { CHAT_STREAM_THROTTLE_MS } from "@/lib/chat-stream-throttle";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import { Spinner } from "@/components/ui/spinner";
import { SweatshopLogo } from "@/components/sweatshop-logo";
import { SandboxViewProvider } from "@/components/sandbox-view";
import { ChatMessageView } from "./chat-cards/message-view";
import { useRoute } from "./chat-session/use-route";
import { useSandboxChoice, useSandboxView } from "./chat-session/use-sandbox";
import { usePendingResume, useResumeStream } from "./chat-session/use-resume";
import { useChatTransport } from "./chat-session/use-transport";
import { useAdoption } from "./chat-session/use-adoption";
import { useTranscriptContext } from "./chat-session/use-transcript-context";
import { useWakePoll } from "./chat-session/use-wake-poll";
import { useOlderMessages, OlderMessagesControl } from "./chat-session/older-messages";
import { useDraft } from "./chat-session/use-draft";
import type { ChatSessionController, ChatSessionState, FreshComposerMode } from "./chat-session/types";

export { ChatMessageView } from "./chat-cards/message-view";
export type { ChatSessionController, ChatSessionState, FreshComposerMode } from "./chat-session/types";

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
 *
 * The state clusters below each live in components/chat-session/ as
 * their own hook: send-time route/sandbox knobs, the fresh-conversation
 * adoption dance, the 0077 live-run resume, transcript-derived context
 * (phase/work-PRs/outline tray) and its wake poll, and the 0075 older-
 * messages window. This function is their composition point plus the
 * composer's own event handlers and the render.
 */

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
  activeStreamCursor,
  projectId,
  initialPrompt,
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
  className,
  ref,
}: {
  conversationId?: string;
  initialMessages?: UIMessage[];
  activeRunId?: string | null;
  /** 0077: the live run's resume cursor (init-only, paired with activeRunId). */
  activeStreamCursor?: number | null;
  projectId?: string;
  /** 0090 §6: the ?prompt= handoff — one-shot initial composer text
   *  for a fresh chat, never auto-sent. */
  initialPrompt?: string;
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
  // See useAdoption below, once messages/isBusy exist, for that dance.

  // 0021: per conversation, not sticky across chats.
  const { route, selectRoute, routeRef } = useRoute(initialRoute);

  // 0013: the fresh composer's one-time sandbox choice ("auto" = own).
  const { sandboxChoice, setSandboxChoice, sandboxes, loadSandboxes, choiceRef } = useSandboxChoice();

  // 0077: a live run this tab is not currently streaming — seeded at
  // mount from the hydrated activeRunId/activeStreamCursor (props), or
  // discovered later (the settled-context fetch, the wake poll).
  const { pendingResume, setPendingResume, pendingResumeRef } = usePendingResume(activeRunId, activeStreamCursor);

  const transport = useChatTransport({
    conversationId,
    projectId,
    pageContext,
    routeRef,
    choiceRef,
    pendingResumeRef,
  });

  // 0077: hydration (initialMessages) already shows every slice the live
  // turn has persisted; useResumeStream below attaches the SDK's own
  // durable stream for whatever comes after — no from-chunk-0 replay,
  // no homemade slice poll.
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

  const chatRef = useRef(chat);
  useEffect(() => {
    chatRef.current = chat;
  });

  const { adoptedNow } = useAdoption({
    adopted,
    conversationId,
    messagesLength: messages.length,
    isBusy,
    onAdopted,
    onAddressable,
  });

  // 0075: the lazy window's older-pages state — olderCursor/olderRemaining
  // are also updated by useResumeStream below, once a resumed stream's
  // tail reload replaces the window.
  const {
    olderCursor,
    setOlderCursor,
    olderRemaining,
    setOlderRemaining,
    olderLoading,
    pagedOnce,
    anchorRef,
    loadOlder,
  } = useOlderMessages({
    conversationId,
    chatRef,
    messages,
    initialOlderCursor,
    initialOlderRemaining,
  });

  useResumeStream({
    chat,
    chatRef,
    conversationId,
    pendingResume,
    setPendingResume,
    setOlderCursor,
    setOlderRemaining,
  });

  // 0022/0075/0079: phase, work PRs and the outline tray's feed, each
  // preferring the whole-transcript server context over the visible
  // window, plus the wake watch that follows from them.
  const {
    phase,
    workPRs: shownWorkPRs,
    outlineContext,
    outlines,
    awaitingWake,
  } = useTranscriptContext({
    messages,
    status,
    adoptedNow,
    isBusy,
    conversationId,
    chatRef,
    pendingResumeRef,
    setPendingResume,
  });

  useWakePoll({ awaitingWake, conversationId, chatRef, pendingResumeRef, setPendingResume });

  // A chat reached via "/" is not "adopted" but exists server-side from
  // its first send, so key on having messages, not on the landing route.
  const started = adopted || messages.length > 0;
  const sandboxView = useSandboxView({ started, conversationId, messages, status });

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

  const fresh = !adopted && messages.length === 0;
  const { textareaRef, handleDraftChange, clearDraft, restoreText, seedDraft } = useDraft({
    adopted,
    conversationId,
    projectId,
    frameId,
  });

  // 0090 §6: a ?prompt= handoff seeds the FRESH composer once, after the
  // draft restore has run — an existing draft wins; never auto-sent.
  const seededPrompt = useRef(false);
  useEffect(() => {
    if (seededPrompt.current || !initialPrompt || !fresh) return;
    seededPrompt.current = true;
    seedDraft(initialPrompt);
  }, [fresh, initialPrompt, seedDraft]);

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
    loadSandboxes,
    sandboxView,
    busy: isBusy,
    status,
    clearDraft,
    phase,
    workPRs: shownWorkPRs,
    messages,
  };

  const outlineView = useMemo<OutlineView>(() => ({
    history: outlines,
    conversationId,
    projectId: projectId ?? null,
  }), [outlines, conversationId, projectId]);
  const freshMode = fresh ? freshComposer?.(state) : undefined;

  // 0042: images upload first (each becomes an attachment id), then the
  // send carries them as file parts pointing at the serving route.
  // 0091 §3: skills attached to the NEXT send — ids, not files, so they
  // live here (per-send state, cleared once the send lands), never in
  // PromptInput's attachment state. The picker's list is fetched on
  // open (cheap and fresh), never on mount.
  const [attachedSkills, setAttachedSkills] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachables, setAttachables] = useState<readonly AttachableSkill[]>([]);
  const [attachablesLoading, setAttachablesLoading] = useState(false);
  useEffect(() => {
    if (!pickerOpen) return;
    let live = true;
    setAttachablesLoading(true);
    void fetchAttachableSkills().then((res) => {
      if (!live) return;
      if (Array.isArray(res)) setAttachables(res);
      setAttachablesLoading(false);
    });
    return () => {
      live = false;
    };
  }, [pickerOpen]);
  const toggleAttached = (id: string) =>
    setAttachedSkills((current) =>
      current.includes(id)
        ? current.filter((skill) => skill !== id)
        : current.length < MAX_ATTACHED_SKILLS
          ? [...current, id]
          : current,
    );
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // A refusal notice is a passing remark, not state: it clears itself.
  useEffect(() => {
    if (!composerNotice) return;
    const timer = setTimeout(() => setComposerNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [composerNotice]);

  const uploadImages = (files: FileUIPart[]): Promise<FileUIPart[]> =>
    Promise.all(
      files.map(async (file) => {
        const blob = await (await fetch(file.url)).blob();
        const form = new FormData();
        form.set("file", new File([blob], file.filename ?? "image", { type: blob.type }));
        const uploaded = await uploadAttachment(form);
        if ("error" in uploaded) throw new Error(uploaded.error);
        return { type: "file" as const, mediaType: uploaded.mediaType, url: uploaded.url, filename: file.filename };
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
    if (attachedSkills.length > 0 && isBusy) {
      // 0091 §3: attached skills shape the turn's instructions — a
      // steered send (text-only) can't carry them either.
      setComposerNotice("Skills can't be added while a turn is running — wait for it to finish.");
      restoreText(text);
      throw new Error("skills while busy");
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
    clearDraft();
    if (isBusy) {
      // A live turn: queue a steer (drained between the turn's slices).
      void steerChat(conversationId, text);
      return;
    }
    // The optimistic user message carries the viewing context as
    // metadata, so the chip shows live (a reload reads the row's).
    // 0091 §3: attached skill ids ride the same metadata — the route
    // reads them from the send's message, the row persists them.
    const viewing = pageContext?.() ?? null;
    const metadata = {
      ...(viewing ? { viewing } : {}),
      ...(attachedSkills.length > 0 ? { attachedSkills } : {}),
    };
    void chat.sendMessage(
      sendPayload(text, files, Object.keys(metadata).length > 0 ? metadata : undefined),
    );
    setAttachedSkills([]);
  };

  const handleStop = async () => {
    chat.stop();
    await cancelChat(conversationId);
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
    [chat, textareaRef],
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
              onLoad={loadOlder}
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
          {/* 0077: driven only by useChat's own status — a tab resumed
              onto a live run (reload, wake, steer) gets the same
              submitted/streaming signal a fresh send does. */}
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

      <div className="composer-dock w-full px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4">
        {/* 0079: detached tinted bar just above the composer (small gap). */}
        <OutlineTray
          key={conversationId}
          conversationId={conversationId}
          projectId={projectId ?? null}
          context={outlineContext}
          busy={isBusy}
        />
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
          <AttachedSkillChips ids={attachedSkills} onRemove={(id) => setAttachedSkills((current) => current.filter((skill) => skill !== id))} />
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
              <ComposerAddButton disabled={isBusy} onAddSkill={() => setPickerOpen(true)} />
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
        <SkillPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          skills={attachables}
          loading={attachablesLoading}
          attached={attachedSkills}
          onToggle={toggleAttached}
        />
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
