"use client";

import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { ChatStatus, ToolUIPart, UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { nanoid } from "nanoid";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  GitPullRequest,
  MessageSquarePlus,
  RotateCcw,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
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
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { AppHeader } from "@/components/app-header";
import {
  SANDBOXED_TOOLS,
  SandboxChip,
  SandboxViewProvider,
  shortSandboxId,
  type ConversationSandboxViewData,
} from "@/components/sandbox-view";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, findChatModel } from "@/lib/model";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";

/** localStorage key for the chosen model (default for new conversations). */
const MODEL_STORAGE_KEY = "sweatshop.model";

/** localStorage prefix for per-conversation composer drafts. */
const DRAFT_PREFIX = "sweatshop.draft.";

/** A running sandbox the composer can attach to. */
interface SandboxOption {
  id: string;
  ownerKind: string;
  ownerId: string;
  projectId: string | null;
  ref: string;
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

/** One coding-harness delegation: status + a link to /h/<kind>/<id>. */
function HarnessToolCard({
  part,
  conversationId,
}: {
  part: ToolUIPart;
  conversationId: string | null;
}) {
  const running = part.state === "input-streaming" || part.state === "input-available";
  const kind = part.type.replace(/^tool-/, "");
  const task = (part.input as { task?: unknown } | undefined)?.task;
  const taskText = typeof task === "string" ? task : undefined;
  const url = conversationId ? `/h/${kind}/${conversationId}` : null;

  return (
    <div className="my-1 rounded-lg border border-info/40 bg-card px-3 py-2.5 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Bot className="size-4 shrink-0 text-info" aria-hidden />
          <span className="shrink-0">{kind} harness</span>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
              (running ? "animate-pulse bg-info/15 text-info" : "bg-success/15 text-success")
            }
          >
            {running ? "running" : "done"}
          </span>
          <SandboxChip toolCallId={part.toolCallId} />
          {taskText && (
            <span className="truncate text-xs font-normal text-muted-foreground">{taskText}</span>
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

/** owner/repo + number read off a PR web URL. */
function prUrlCoords(url: string): { repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: match[3] } : null;
}

/** One create_pr call: status pill, title, branch chips, link out. */
function PullRequestToolCard({ part }: { part: ToolUIPart }) {
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
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
  const prNumber = typeof output?.number === "number" ? output.number : undefined;
  const coords = url ? prUrlCoords(url) : null;
  const numberText = coords?.number ?? (prNumber !== undefined ? String(prNumber) : undefined);
  const errorText = failed ? (part.errorText ?? "create_pr failed") : undefined;

  return (
    <Tool className={cn("my-1", failed && "border-destructive/40")}>
      <div className="flex w-full items-center justify-between gap-3 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <GitPullRequest
            className={cn(
              "size-4 shrink-0",
              failed ? "text-destructive" : running ? "text-info" : "text-success",
            )}
            aria-hidden
          />
          <span className="truncate font-medium">
            {title ?? (running ? "Opening pull request…" : "Pull request")}
          </span>
          <span
            className={
              "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase " +
              (failed
                ? "bg-destructive/15 text-destructive"
                : running
                  ? "animate-pulse bg-info/15 text-info"
                  : "bg-success/15 text-success")
            }
          >
            {failed ? "failed" : running ? "opening" : "opened"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(coords?.repo || numberText) && (
            <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
              {[coords?.repo, numberText && `#${numberText}`].filter(Boolean).join(" ")}
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
            {!coords?.repo && repoDir && <span className="font-mono">{repoDir}</span>}
          </div>
        )}
        {body && (
          <div className="text-sm text-muted-foreground">
            <MessageResponse>{body}</MessageResponse>
          </div>
        )}
        {showInput && input && <ToolInput input={part.input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput output={output} errorText={errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}

/** An ask_chad call awaiting Chad: approvals get Approve/Deny, questions
 *  get a freeform answer box — matching what the tool asked for. */
function AskChadCard({ part }: { part: ToolUIPart }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const answered = part.state === "output-available" || part.state === "output-error";
  const input = part.input as { kind?: unknown; question?: unknown } | undefined;
  const kind = input?.kind === "question" ? "question" : "approval";
  const question = typeof input?.question === "string" ? input.question : undefined;

  const post = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await fetch("/api/x/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: part.toolCallId, ...payload }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-1 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">
        {kind === "question" ? "Question for you: " : "Approve? "}
        {question}
      </p>
      {!answered ? (
        kind === "question" ? (
          <div className="mt-2 flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Your answer…"
              disabled={busy}
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) void post({ answer: draft });
              }}
            />
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void post({ answer: draft })}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Answer
            </button>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ approved: true })}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ approved: false })}
              className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        )
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {part.state === "output-available" ? String(part.output) : "no answer recorded"}
        </p>
      )}
    </div>
  );
}

/** One tool call, collapsed by default. */
const ToolCallView = ({ part }: { part: ToolUIPart }) => {
  const input = part.state === "input-streaming" ? undefined : part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText = part.state === "output-error" ? (part.errorText ?? "tool failed") : undefined;
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={part.type.replace(/^tool-/, "")}
        extra={
          SANDBOXED_TOOLS.has(part.type.replace(/^tool-/, "")) ? (
            <SandboxChip toolCallId={part.toolCallId} />
          ) : undefined
        }
      />
      <ToolContent>
        {input !== undefined && <ToolInput input={input} />}
        {(output !== undefined || errorText !== undefined) && (
          <ToolOutput output={output} errorText={errorText} />
        )}
      </ToolContent>
    </Tool>
  );
};

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

function formatTurnTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Render one message with the AI Elements kit (memoized per message). */
export const ChatMessageView = memo(function ChatMessageView({
  message,
  conversationId,
}: {
  message: UIMessage;
  conversationId?: string | null;
}) {
  const text = useMemo(
    () =>
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim(),
    [message.parts],
  );
  const atIso = (message.metadata as { at?: unknown } | undefined)?.at;
  const timeIso = typeof atIso === "string" ? atIso : undefined;
  const timeText = timeIso ? formatTurnTime(timeIso) : "";
  // Timestamps format in the visitor's locale/timezone, which the server
  // (UTC) cannot predict — render them only once mounted (see use-mounted).
  const mounted = useMounted();
  const showTime = timeText !== "" && mounted;

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type.startsWith("tool-")) {
            const toolPart = part as ToolUIPart;
            if (toolPart.type === "tool-ask_chad") return <AskChadCard key={i} part={toolPart} />;
            if (toolPart.type === "tool-pi" || toolPart.type === "tool-claude") {
              return (
                <HarnessToolCard key={i} part={toolPart} conversationId={conversationId ?? null} />
              );
            }
            if (toolPart.type === "tool-create_pr") {
              return <PullRequestToolCard key={i} part={toolPart} />;
            }
            return <ToolCallView key={i} part={toolPart} />;
          }
          return null;
        })}
      </MessageContent>
      {(text || showTime) && (
        <MessageActions
          className={cn(
            "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
            message.role === "user" && "self-end",
          )}
        >
          {showTime && (
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

/** Model picker — a per-conversation knob, applied on the next send. */
function ModelPicker({
  selectedId,
  onSelect,
  displayLabel,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
  displayLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Chat model"
          title="Model for this conversation"
          className="inline-flex h-8 max-w-40 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
              className={cn("mt-0.5", model.id === selectedId ? "opacity-100" : "opacity-0")}
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

/** Sandbox picker — the explicit knob from docs/0010 (auto / none / attach). */
/**
 * What the trigger says. The stored choice ("auto") is not an answer to
 * "where will my next command run?", so prefer the resolved state.
 */
function sandboxLabel(
  pref: string,
  view: ConversationSandboxViewData | null,
  sandboxes: SandboxOption[],
): string {
  const state = view?.state;
  if (pref === "none" || state?.kind === "none") return "no sandbox";
  if (pref.startsWith("attached:")) {
    const id = pref.slice("attached:".length);
    const label = view?.sandboxes[id]?.ownerLabel ?? sandboxes.find((s) => s.id === id)?.ownerId;
    return `attached: ${label ?? id.slice(4, 12)}`;
  }
  if (state?.kind === "unavailable") return "no sandbox (no project)";
  if (state?.kind === "own") return `sandbox: ${shortSandboxId(state.sandboxId)}`;
  return "sandbox: auto";
}

function SandboxPicker({
  pref,
  onSelect,
  onOpen,
  sandboxes,
  view,
}: {
  /** 0011: the server-resolved state; the label prefers it over `pref`. */
  view: ConversationSandboxViewData | null;
  pref: string;
  onSelect: (pref: string) => void;
  /** Fired each time the menu opens — refresh the attachable list. */
  onOpen: () => void;
  sandboxes: SandboxOption[];
}) {
  const label = sandboxLabel(pref, view, sandboxes);
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Sandbox"
          title="Sandbox for this conversation — auto (own, created on first use), none, or attach to a running sandbox"
          className="inline-flex h-8 max-w-40 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuItem onSelect={() => onSelect("auto")}>
          <Check className={cn(pref === "auto" ? "opacity-100" : "opacity-0")} aria-hidden />
          <span className="flex flex-col">
            <span>Auto</span>
            <span className="text-xs font-normal text-muted-foreground">
              Own sandbox, created on first use
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect("none")}>
          <Check className={cn(pref === "none" ? "opacity-100" : "opacity-0")} aria-hidden />
          <span className="flex flex-col">
            <span>None</span>
            <span className="text-xs font-normal text-muted-foreground">
              No sandboxed tools
            </span>
          </span>
        </DropdownMenuItem>
        {sandboxes.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Attach to a running sandbox</DropdownMenuLabel>
            {sandboxes.map((sandbox) => (
              <DropdownMenuItem
                key={sandbox.id}
                onSelect={() => onSelect(`attached:${sandbox.id}`)}
              >
                <Check
                  className={cn(
                    `attached:${sandbox.id}` === pref ? "opacity-100" : "opacity-0",
                  )}
                  aria-hidden
                />
                <span className="flex flex-col">
                  <span className="font-mono text-xs">{sandbox.ownerId}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {sandbox.ownerKind}
                    {sandbox.projectId ? ` · ${sandbox.projectId}` : ""}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The sweatshop chat surface (0010 Phase 4): one WorkflowAgent turn per
 * message, streamed through WorkflowChatTransport. Conversations are
 * URL-addressed — `/` starts fresh (a client-generated c_ id adopted on
 * first send), `/c/[id]` rehydrates history from sqlite and reattaches
 * to a live turn (the active run id doubles as the chat id, which the
 * transport uses to reconnect). While a turn runs, sending queues a
 * steer instead of a new turn.
 */
export function ChatSurface({
  conversationId: initialConversationId,
  initialMessages,
  activeRunId,
  projectId,
  projectName,
  initialModelId,
  initialSandboxPref,
  conversationTitle,
  headerExtra,
}: {
  conversationId?: string;
  initialMessages?: UIMessage[];
  activeRunId?: string | null;
  projectId?: string;
  projectName?: string;
  initialModelId?: string | null;
  initialSandboxPref?: string | null;
  conversationTitle?: string | null;
  headerExtra?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useMounted();

  // Landing pages hold no conversation yet — the id is client-generated
  // and adopted by the server on the first send.
  const [freshId] = useState(() => `c_${nanoid()}`);
  const conversationId = initialConversationId ?? freshId;
  const adopted = Boolean(initialConversationId);

  const [storedModelId, setStoredModelId] = useState<string>(() => {
    if (typeof window === "undefined") return initialModelId ?? DEFAULT_CHAT_MODEL.id;
    return (
      window.localStorage.getItem(MODEL_STORAGE_KEY) ??
      initialModelId ??
      DEFAULT_CHAT_MODEL.id
    );
  });
  const modelId = findChatModel(storedModelId)?.id ?? DEFAULT_CHAT_MODEL.id;
  const selectModel = (id: string) => {
    setStoredModelId(id);
    window.localStorage.setItem(MODEL_STORAGE_KEY, id);
  };

  const [sandboxPref, setSandboxPref] = useState(initialSandboxPref ?? "auto");
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
  const modelRef = useRef(modelId);
  const prefRef = useRef(sandboxPref);
  // 0011: the pref is only sent once the user has chosen one in the
  // picker. Otherwise an agent-side change (attach_sandbox sets the
  // conversation's pref) would be overwritten by the stale "auto" on the
  // next send.
  const prefTouchedRef = useRef(false);
  const conversationRef = useRef({ conversationId, projectId: projectId ?? null });
  useEffect(() => {
    modelRef.current = modelId;
    prefRef.current = sandboxPref;
    conversationRef.current = { conversationId, projectId: projectId ?? null };
  }, [modelId, sandboxPref, conversationId, projectId]);

  // eslint-disable-next-line react-hooks/refs -- the callback runs at
  // send time (never during render) and must see the current knobs.
  const [transport] = useState(
    () =>
      new WorkflowChatTransport({
        api: "/api/x/chat",
        prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
          body: {
            conversationId: conversationRef.current.conversationId,
            projectId: conversationRef.current.projectId,
            modelId: modelRef.current,
            ...(prefTouchedRef.current
              ? { sandboxPref: prefRef.current === "auto" ? null : prefRef.current }
              : {}),
            messages,
            trigger,
            messageId,
          },
        }),
      }),
  );

  const chat = useChat({
    id: activeRunId ?? conversationId,
    resume: Boolean(activeRunId),
    transport,
    ...(initialMessages && initialMessages.length > 0 ? { messages: initialMessages } : {}),
  });

  const status = mounted ? chat.status : "ready";
  const isBusy = status === "submitted" || status === "streaming";
  const messages = chat.messages;

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
          // The agent can change the choice server-side (attach_sandbox);
          // follow it until the user has picked something themselves.
          if (!prefTouchedRef.current) {
            setSandboxPref(
              next.state.kind === "attached"
                ? `attached:${next.state.sandboxId}`
                : next.state.kind === "none"
                  ? "none"
                  : "auto",
            );
          }
        }
      } catch {
        // chips and the state label are best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [started, conversationId, sandboxSignature]);

  // Sidebar live-refresh once the first send creates the conversation.
  const refreshedRef = useRef<string | null>(null);
  useEffect(() => {
    if (adopted || messages.length === 0) return;
    if (refreshedRef.current === conversationId) return;
    refreshedRef.current = conversationId;
    window.history.replaceState(null, "", `/c/${conversationId}`);
    router.refresh();
  }, [adopted, conversationId, messages.length, router]);

  // Opening a thread marks it read (visible + focused only).
  useMarkSeen(adopted ? conversationId : null, `${messages.length}:${isBusy ? "busy" : status}`);

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

  // ── Draft persistence (unchanged mechanism) ───────────────────────────
  const draftKey = DRAFT_PREFIX + (adopted ? conversationId : projectId ?? "new");
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

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text) return;
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
    void chat.sendMessage({ text });
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
    if (!lastUserText) return;
    void chat.sendMessage({ text: lastUserText });
  };

  const handleNewChat = () => {
    if (projectId) {
      window.history.replaceState(null, "", `/p/${projectId}`);
    } else if (pathname === "/" || window.location.pathname.startsWith("/c/")) {
      window.history.replaceState(null, "", "/");
    } else {
      router.push("/");
      return;
    }
    chat.setMessages([]);
    textareaRef.current?.focus();
  };

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
      <AppHeader
        crumbs={[
          projectId
            ? { label: projectName ?? projectId, href: `/p/${projectId}` }
            : { label: "Chats", href: "/" },
          { label: conversationTitle ?? "New chat" },
        ]}
      >
        <ModelPicker
          selectedId={modelId}
          onSelect={selectModel}
          displayLabel={findChatModel(modelId)?.label ?? modelId}
        />
        <SandboxPicker
          pref={sandboxPref}
          onSelect={(pref) => {
            prefTouchedRef.current = true;
            setSandboxPref(pref);
          }}
          onOpen={() => void loadSandboxes()}
          sandboxes={sandboxes}
          view={sandboxView}
        />
        {headerExtra}
      </AppHeader>

      <Conversation className="min-h-0 flex-1">
        <ConversationContent>
          {messages.length === 0 && status === "ready" && !chat.error && (
            <ConversationEmptyState
              icon={<MessageSquarePlus className="size-6" />}
              title="sweatshop"
              description="A conversation with your agent. Say anything to begin."
            />
          )}
          <SandboxViewProvider value={sandboxView}>
          {messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              conversationId={adopted ? conversationId : null}
            />
          ))}
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

      <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-4">
        <PromptInput onSubmit={handleSubmit} className="composer">
          <PromptInputTextarea
            ref={textareaRef}
            onChange={handleDraftChange}
            placeholder={isBusy ? "Steer the running turn…" : "Message sweatshop…"}
            autoFocus
          />
          <PromptInputFooter>
            <PromptInputSubmit
              status={status}
              onStop={() => void handleStop()}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
