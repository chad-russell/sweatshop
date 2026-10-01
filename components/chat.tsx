"use client";

import type { ChatStatus } from "ai";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { Bot, Check, ChevronDown, ChevronsUpDown, Copy, GitPullRequest, Lock, MessageSquarePlus, RotateCcw, SquarePen } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { memo, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  useEveAgent,
  type EveDynamicToolPart,
  type EveMessage,
  type UseEveAgentStatus,
} from "eve/react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "@/components/ai-elements/tool";
import { ThemeToggle } from "@/components/theme-toggle";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  CHAT_MODELS,
  DEFAULT_CHAT_MODEL,
  findChatModel,
} from "@/lib/model";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";

/** localStorage key for the chosen model (applies to new conversations). */
const MODEL_STORAGE_KEY = "sweatshop.model";

/** localStorage prefix for per-conversation composer drafts. The suffix is
 *  the conversation id once known, else the project id (project landing) or
 *  "new" (the bare landing) — so drafts never leak across conversations. */
const DRAFT_PREFIX = "sweatshop.draft.";

/** eve status → the ChatStatus shape PromptInputSubmit understands. */
function toChatStatus(status: UseEveAgentStatus): ChatStatus {
  // "resuming" disables submission anyway; "submitted" gives the right
  // disabled-submit presentation while catch-up runs.
  return status === "resuming" ? "submitted" : status;
}

/** True while a turn is running but no answer text has started. */
function isThinking(status: UseEveAgentStatus, messages: readonly EveMessage[]) {
  if (status === "submitted") return true;
  if (status !== "streaming") return false;
  const last = messages[messages.length - 1];
  return !(
    last?.role === "assistant" &&
    last.parts.some((part) => part.type === "text" && part.text)
  );
}

/** One coding-harness delegation, rendered as a branded card (0005/0006):
 *  status (running/done) + a link to that harness's /h session view. */
function HarnessToolCard({
  part,
  conversationId,
}: {
  part: EveDynamicToolPart;
  conversationId: string | null;
}) {
  const running = part.state === "input-streaming" || part.state === "input-available";
  const task = (part.input as { task?: unknown } | undefined)?.task;
  const taskText = typeof task === "string" ? task : undefined;
  const url = conversationId ? `/h/${part.toolName}/${conversationId}` : null;

  return (
    <div className="my-1 rounded-lg border border-info/40 bg-card px-3 py-2.5 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Bot className="size-4 shrink-0 text-info" aria-hidden />
          <span className="shrink-0">{part.toolName} harness</span>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
              (running
                ? "animate-pulse bg-info/15 text-info"
                : "bg-success/15 text-success")
            }
          >
            {running ? "running" : "done"}
          </span>
          {taskText && (
            <span className="truncate text-xs font-normal text-muted-foreground">
              {taskText}
            </span>
          )}
        </span>
        {url && (
          <a
            href={url}
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            View session →
          </a>
        )}
      </div>
    </div>
  );
}

/** owner/repo + number read off a PR web URL (github /pull/N, forgejo /pulls/N). */
function prUrlCoords(url: string): { repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: match[3] } : null;
}

/** One create_pr call, rendered as a PR card (same slot as the harness
 *  cards): status pill, title, and a link out to the VCS — url/number ride
 *  the tool output, title/body/branches the tool input. Expanding shows the
 *  description, branch chips, and the raw JSON the generic view would have. */
function PullRequestToolCard({ part }: { part: EveDynamicToolPart }) {
  const running =
    part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const waiting =
    part.state === "approval-requested" || part.state === "approval-responded";
  const showInput = part.state !== "input-streaming";
  const input = (showInput ? part.input : undefined) as {
    title?: unknown;
    body?: unknown;
    head?: unknown;
    base?: unknown;
    repo?: unknown;
  } | undefined;
  const title = typeof input?.title === "string" ? input.title : undefined;
  const body = typeof input?.body === "string" ? input.body : undefined;
  const head = typeof input?.head === "string" ? input.head : undefined;
  const base = typeof input?.base === "string" ? input.base : "main";
  const repoDir = typeof input?.repo === "string" ? input.repo : undefined;
  const output =
    part.state === "output-available"
      ? (part.output as { url?: unknown; number?: unknown } | undefined)
      : undefined;
  const url = typeof output?.url === "string" ? output.url : undefined;
  const prNumber =
    typeof output?.number === "number" ? output.number : undefined;
  const coords = url ? prUrlCoords(url) : null;
  const numberText = coords?.number ?? (prNumber !== undefined ? String(prNumber) : undefined);
  const errorText = failed ? (part.errorText ?? "create_pr failed") : undefined;

  return (
    <Tool className={cn("my-1", (failed || denied) && "border-destructive/40")}>
      <div className="flex w-full items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <GitPullRequest
            className={cn(
              "size-4 shrink-0",
              failed || denied
                ? "text-destructive"
                : running
                  ? "text-info"
                  : "text-success",
            )}
            aria-hidden
          />
          <span className="truncate font-medium">
            {title ?? (running ? "Opening pull request…" : "Pull request")}
          </span>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
              (failed || denied
                ? "bg-destructive/15 text-destructive"
                : running
                  ? "animate-pulse bg-info/15 text-info"
                  : waiting
                    ? "bg-warning/15 text-warning"
                    : "bg-success/15 text-success")
            }
          >
            {failed
              ? "failed"
              : denied
                ? "denied"
                : running
                  ? "opening"
                  : waiting
                    ? "awaiting approval"
                    : "opened"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(coords?.repo || numberText) && (
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
              {[coords?.repo, numberText && `#${numberText}`]
                .filter(Boolean)
                .join(" ")}
            </span>
          )}
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              View PR →
            </a>
          )}
          <CollapsibleTrigger
            aria-label="Toggle create_pr details"
            title="Details"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
        </div>
      </div>
      <ToolContent>
        {head && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{head}</span>
            <span aria-hidden>→</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{base}</span>
            {!coords?.repo && repoDir && (
              <span className="font-mono">{repoDir}</span>
            )}
          </div>
        )}
        {body && (
          <div className="text-sm text-muted-foreground">
            <MessageResponse>{body}</MessageResponse>
          </div>
        )}
        {showInput && input && <ToolInput input={part.input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput
            output={output as ToolPart["output"]}
            errorText={errorText as ToolPart["errorText"]}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

/** One tool call, collapsed by default: header (name + lifecycle state),
 *  expandable to the JSON input and output/error. */
const ToolCallView = ({ part }: { part: EveDynamicToolPart }) => {
  const input = part.state === "input-streaming" ? undefined : part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText =
    part.state === "output-error" ? (part.errorText ?? "tool failed") : undefined;
  return (
    <Tool>
      {/* eve's state union is a superset of the kit's (approval states);
          the kit's badges cover the overlap. */}
      <ToolHeader
        type="dynamic-tool"
        state={part.state as ToolPart["state"]}
        toolName={part.toolName}
      />
      <ToolContent>
        {input !== undefined && <ToolInput input={input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput
            output={output as ToolPart["output"]}
            errorText={errorText as ToolPart["errorText"]}
          />
        )}
      </ToolContent>
    </Tool>
  );
};

/** Copy button for one message: self-contained state (a 2s check
 *  confirmation). Uses the shared copyText helper, which falls back to
 *  execCommand for the LAN http origins where navigator.clipboard is
 *  not exposed; a total failure is a silent no-op. */
function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  const copy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <MessageAction
      type="button"
      tooltip={copied ? "Copied" : "Copy message"}
      aria-label="Copy message"
      onClick={() => void copy()}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </MessageAction>
  );
}

/** Hover-label for a turn's time: clock time today, date otherwise; the
 *  full local timestamp rides the title attribute. */
function formatTurnTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Render one eve message with the AI Elements kit. EveMessage parts follow
 * the UIMessage rendering convention: text streams through
 * MessageResponse, model reasoning through the collapsible Reasoning kit,
 * tool calls through the Tool kit. Parts we don't render yet (HITL
 * approval prompts, authorization challenges) are skipped.
 *
 * Memoized on message identity: eve's reducer clones only the streaming
 * message per delta, so during a turn every completed message — including
 * its markdown re-parse — skips re-render.
 */
export const EveMessageView = memo(function EveMessageView({
  message,
  conversationId,
  turnStart,
  turnEnd,
}: {
  message: EveMessage;
  conversationId?: string | null;
  turnStart?: string;
  turnEnd?: string;
}) {
  // Concatenated text parts — the clipboard payload for the copy action.
  // Tool-only messages have none and get no action row.
  const text = useMemo(
    () =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim(),
    [message.parts],
  );
  // User bubbles show when the turn was sent; assistant bubbles when it
  // finished (falling back to its start for in-flight/failed turns).
  const timeIso =
    message.role === "assistant" ? (turnEnd ?? turnStart) : turnStart;
  const timeText = timeIso ? formatTurnTime(timeIso) : "";

  return (
    <Message
      from={message.role}
      className={cn(
        "[content-visibility:auto] [contain-intrinsic-size:auto_80px]",
        // A submission that never reached the server stays projected with
        // status "failed" — mute it so the retry's live copy reads as the
        // real one.
        message.metadata?.status === "failed" && "opacity-60",
      )}
    >
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type === "reasoning" && part.text) {
            return (
              <Reasoning key={i} isStreaming={part.state === "streaming"}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            );
          }
          if (
            part.type === "dynamic-tool" &&
            (part.toolName === "pi" || part.toolName === "claude")
          ) {
            return (
              <HarnessToolCard key={i} part={part} conversationId={conversationId ?? null} />
            );
          }
          if (part.type === "dynamic-tool" && part.toolName === "create_pr") {
            return <PullRequestToolCard key={i} part={part} />;
          }
          if (part.type === "dynamic-tool") {
            return <ToolCallView key={i} part={part} />;
          }
          return null;
        })}
      </MessageContent>
      {(text || timeText) && (
        <MessageActions
          className={cn(
            "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
            message.role === "user" && "self-end",
          )}
        >
          {timeText && (
            <time
              dateTime={timeIso}
              title={timeIso ? new Date(timeIso).toLocaleString() : undefined}
              className="px-1 font-mono text-[10px] text-muted-foreground"
            >
              {timeText}
            </time>
          )}
          {text && <MessageCopyButton text={text} />}
        </MessageActions>
      )}
    </Message>
  );
});

/**
 * Chat model picker. The selection binds at session creation
 * (x-sweatshop-model → channel principal attributes, immutable for the
 * session's life — same contract as the project binding), so once this
 * surface holds a session the picker is replaced by a plain locked
 * badge — not a disabled control — to make "choose at the start" the
 * visible affordance. The badge shows the model the session actually
 * runs, derived from its stream.
 */
function ModelPicker({
  selectedId,
  onSelect,
  locked,
  displayLabel,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  locked: boolean;
  displayLabel: string;
}) {
  if (locked) {
    return (
      <span
        className="inline-flex h-9 max-w-full cursor-not-allowed items-center gap-1.5 rounded-md border border-border px-2.5 text-sm text-muted-foreground"
        title="Model is fixed for this conversation — it's chosen when the conversation starts"
      >
        <Lock className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{displayLabel}</span>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Chat model"
          title="Model for this conversation — fixed once you send"
          className="inline-flex h-9 max-w-full items-center gap-1 rounded-md border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {CHAT_MODELS.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onSelect={() => onSelect(model.id)}
            className="items-start py-2"
          >
            <Check
              className={cn(
                "mt-0.5",
                model.id === selectedId ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
            <span className="flex flex-col">
              <span>{model.label}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {model.description}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The sweatshop chat surface (0002): one durable eve session per
 * conversation, driven by useEveAgent. Conversations are URL-addressed —
 * `/` starts fresh and the URL is replaced with `/c/[sessionId]` once the
 * first send creates the session (no remount, per the generated-web-chat
 * pattern); opening `/c/[sessionId]` resumes by replaying the durable
 * stream from index 0.
 */
export function ChatSurface({
  sessionId,
  projectId,
  projectName,
  headerExtra,
}: {
  sessionId?: string;
  projectId?: string;
  projectName?: string;
  headerExtra?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  // With resume: true the hook's client-first status is "resuming" while
  // the server rendered "ready" — render a deterministic "ready" until
  // hydration completes so disabled states can't mismatch.
  const mounted = useMounted();

  // Model for the NEXT session this surface creates, restored from
  // localStorage (lazily, client-side). The rendered label is gated on
  // `mounted` below so hydration stays deterministic; the headers
  // callback re-resolves on every request, and no request can precede
  // mount, so the stored choice applies to the first send.
  const [storedModelId, setStoredModelId] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_CHAT_MODEL.id;
    return (
      window.localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_CHAT_MODEL.id
    );
  });
  // A stored id can go stale when the model table changes — resolve to
  // a real model rather than sending an unknown id.
  const modelId = findChatModel(storedModelId)?.id ?? DEFAULT_CHAT_MODEL.id;
  const selectModel = (id: string) => {
    setStoredModelId(id);
    window.localStorage.setItem(MODEL_STORAGE_KEY, id);
  };

  // Sidebar live-refresh bookkeeping: the session id whose layout refresh
  // has already been triggered (see onSessionChange).
  const refreshedSessionRef = useRef<string | null>(null);

  // True once handleNewChat resets this surface in place: the sessionId
  // prop then describes a conversation this surface no longer holds, so
  // URL adoption, the sidebar refresh, the model-picker lock, the draft
  // key and harness links must all treat the surface as a landing page
  // again. Mirrored into a ref for the useEveAgent callback.
  const [landed, setLandedState] = useState(false);
  const landedRef = useRef(false);
  const setLanded = (value: boolean) => {
    landedRef.current = value;
    setLandedState(value);
  };

  const agent = useEveAgent({
    initialSession: sessionId ? { sessionId, streamIndex: 0 } : undefined,
    resume: sessionId !== undefined,
    // Session-creation bindings ride the channel auth (immutable for the
    // session's life): the project from the page, the model from the
    // picker. The header is sent on every request, but only the creating
    // request's principal becomes the session's initiator.
    headers: () => {
      const headers: Record<string, string> = {
        "x-sweatshop-model": modelId,
      };
      if (projectId) headers["x-sweatshop-project"] = projectId;
      return headers;
    },
    onSessionChange(session) {
      // From a landing page, adopt the new session's URL without
      // remounting the active stream. On /c/[sessionId] the URL is
      // already correct — unless handleNewChat reset the surface in
      // place, after which it is a landing page again (`landed`).
      if (!session || (sessionId && !landedRef.current)) return;
      window.history.replaceState(null, "", `/c/${session.sessionId}`);
      // A conversation started mid-page shows up in the sidebar now, not
      // on the next navigation: refresh the server layout (a refresh
      // re-renders RSC payload but preserves client state, so the live
      // stream is untouched). Once per session id — the session cursor
      // advances as the stream does.
      if (refreshedSessionRef.current !== session.sessionId) {
        refreshedSessionRef.current = session.sessionId;
        router.refresh();
      }
    },
  });

  const displayStatus = mounted ? agent.status : "ready";
  // Conversation id for harness links: the /c route param, else the
  // live session cursor once the first send creates it. After an
  // in-place reset the route param describes a conversation this
  // surface no longer holds — ignore it.
  const conversationId = landed
    ? (agent.session?.sessionId ?? null)
    : (sessionId ?? agent.session?.sessionId ?? null);
  const isBusy = displayStatus === "submitted" || displayStatus === "streaming";
  // Opening a thread marks it read (visible + focused only); re-marks when
  // a turn lands so the thread on screen never grows an unread dot.
  useMarkSeen(conversationId, `${agent.data.messages.length}:${isBusy ? "busy" : displayStatus}`);
  const isResuming = displayStatus === "resuming";
  const inputDisabled = isResuming;
  const messages = agent.data.messages;

  // Turn timing from the authoritative stream: every server event carries
  // meta.at (ISO, stable across replays) and turn-scoped events carry
  // data.turnId. First event per turn = turn start; last = turn end. Used
  // for hover timestamps via message.metadata.turnId — EveMessage itself
  // has no clock field.
  const { turnStarts, turnEnds } = useMemo(() => {
    const turnStarts = new Map<string, string>();
    const turnEnds = new Map<string, string>();
    for (const event of agent.events) {
      const e = event as {
        type: string;
        data?: { turnId?: unknown };
        meta?: { at?: unknown };
      };
      const turnId = typeof e.data?.turnId === "string" ? e.data.turnId : null;
      const at = typeof e.meta?.at === "string" ? e.meta.at : null;
      if (!turnId || !at) continue;
      if (!turnStarts.has(turnId)) turnStarts.set(turnId, at);
      turnEnds.set(turnId, at);
    }
    return { turnStarts, turnEnds };
  }, [agent.events]);

  // This surface holds a conversation once resumed by id, after the
  // first send adopts a session, or as soon as any message is projected
  // (the optimistic first send covers the window before the session
  // cursor lands) — from then on its model is fixed (the channel
  // attributes the initiator carried at creation are immutable), so the
  // picker locks. agent.session is optional: absent before the first
  // send, not null. An in-place reset (`landed`) un-holds the resumed
  // id — the next send starts an unbound conversation.
  const conversationBound =
    (sessionId !== undefined && !landed) ||
    Boolean(agent.session) ||
    messages.length > 0;

  // What a bound session actually runs: the concrete modelId of its
  // latest model step (each public step.started carries it,
  // provider-prefixed, e.g. "zhipu/glm-5.3-flash"). Null before the
  // first step — then the picker falls back to the selected label.
  const sessionModelId = useMemo(() => {
    for (let i = agent.events.length - 1; i >= 0; i--) {
      const event = agent.events[i] as {
        type: string;
        data?: { modelId?: unknown };
      };
      if (event.type !== "step.started") continue;
      if (typeof event.data?.modelId === "string") {
        return event.data.modelId.split("/").pop() ?? event.data.modelId;
      }
    }
    return null;
  }, [agent.events]);
  const displayModel = conversationBound
    ? sessionModelId !== null
      ? (findChatModel(sessionModelId)?.label ?? sessionModelId)
      : mounted
        ? (findChatModel(modelId)?.label ?? modelId)
        : DEFAULT_CHAT_MODEL.label
    : mounted
      ? (findChatModel(modelId)?.label ?? modelId)
      : DEFAULT_CHAT_MODEL.label;

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text || inputDisabled) return;
    // The draft left the composer — stop persisting it.
    window.localStorage.removeItem(draftKey);
    void agent.send(text, isBusy ? { turnPolicy: "steer" } : undefined);
  };

  // Text of the newest user message — the retry payload. A submission that
  // died in transport stays projected as a failed optimistic message; a
  // server-side turn failure leaves the confirmed user message last. Either
  // way this is "what was being asked", and send() re-asks it (eve exposes
  // no reload/truncate, so the transcript gains the resend — the failed
  // attempt is muted above).
  const lastUserText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      return text || null;
    }
    return null;
  }, [messages]);

  const handleRetry = () => {
    if (!lastUserText || inputDisabled) return;
    void agent.send(lastUserText);
  };

  // ── Draft persistence ────────────────────────────────────────────────
  // Restored imperatively after mount: reading localStorage during render
  // would mismatch the server-rendered HTML. Saved on every keystroke, so
  // navigating away mid-thought and back (or a reload) keeps the text. The
  // key follows the conversation — the route param, else the live session
  // once the first send adopts it, else the project landing, else "new".
  const draftKey = DRAFT_PREFIX + (conversationId ?? projectId ?? "new");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(draftKey);
    // Only seed an empty composer — form.reset() emptied it on the send
    // that adopted the session, so a live keystroke is never clobbered.
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

  const handleNewChat = () => {
    if (projectId) {
      // Project-bound surface — a /p page, its adopted /c/... URL, or a
      // /c/[sessionId] whose conversation carries the binding (the page
      // resolves it from the store): reset in place on the project
      // route, so ⌘⇧O / the header button start the next chat in the
      // same project.
      window.history.replaceState(null, "", `/p/${projectId}`);
      agent.reset();
      setLanded(true);
    } else if (pathname === "/") {
      // Still on the landing route (URL may have been replaced to /c/...):
      // reset local state and the URL in place — the prior durable session
      // remains available at its URL.
      window.history.replaceState(null, "", "/");
      agent.reset();
      setLanded(true);
    } else {
      // On /c/[sessionId]: navigate to the sessionless landing route.
      router.push("/");
    }
    // The reset emptied the composer; land the caret back in it.
    textareaRef.current?.focus();
  };

  // ⌘⇧O starts a new chat from anywhere in the surface (⌘K owns search).
  // The handler is kept in a ref so the window listener itself is stable
  // across renders — handleNewChat closes over the agent snapshot.
  const newChatRef = useRef(handleNewChat);
  useEffect(() => {
    newChatRef.current = handleNewChat;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-sm text-muted-foreground">
            sweatshop{projectName ? ` / ${projectName}` : ""}
          </span>
          <ModelPicker
            selectedId={conversationBound ? (sessionModelId ?? modelId) : modelId}
            onSelect={selectModel}
            locked={conversationBound}
            displayLabel={displayModel}
          />
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          <button
            type="button"
            aria-label="New chat"
            title="New chat (⌘⇧O)"
            disabled={isResuming}
            onClick={handleNewChat}
            className="inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <SquarePen className="size-4" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 && displayStatus === "ready" && !agent.error && (
            <ConversationEmptyState
              icon={<MessageSquarePlus className="size-6" />}
              title="sweatshop"
              description="A conversation with your agent. Say anything to begin."
            />
          )}
          {messages.map((message) => {
            const turnId = message.metadata?.turnId;
            return (
              <EveMessageView
                key={message.id}
                message={message}
                conversationId={conversationId}
                turnStart={turnId ? turnStarts.get(turnId) : undefined}
                turnEnd={turnId ? turnEnds.get(turnId) : undefined}
              />
            );
          })}
          {isThinking(displayStatus, messages) && (
            <div
              className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner className="size-4" />
              Thinking…
            </div>
          )}
          {agent.error && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 py-2 text-sm text-destructive"
            >
              <span className="min-w-0 flex-1 break-words">{agent.error.message}</span>
              {lastUserText && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-xs font-medium transition-colors hover:bg-destructive/10"
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

      <div className="border-t p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            ref={textareaRef}
            onChange={handleDraftChange}
            placeholder="Message sweatshop…"
            disabled={inputDisabled}
            autoFocus
          />
          <PromptInputSubmit
            status={toChatStatus(displayStatus)}
            onStop={() => void agent.cancel()}
          />
        </PromptInput>
      </div>
    </div>
  );
}
