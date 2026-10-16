"use client";

import { WorkflowChatTransport } from "@ai-sdk/workflow/client";
import type { ChatStatus, FileUIPart, ToolUIPart, UIMessage } from "ai";
import { useChat } from "@ai-sdk/react";
import { nanoid } from "nanoid";
import { Check, ChevronDown, Copy, Eye, GitPullRequest, MessageSquarePlus, RotateCcw } from "lucide-react";
import {
  Fragment,
  memo,
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
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  InspectCard,
  HostExecCard,
  SandboxExecCard,
  StartThreadCard,
} from "@/components/ai-elements/agent-cards";
import { ComposerAddButton, ComposerAttachments, attachmentErrorMessage } from "@/components/composer-attachments";
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from "@/lib/attachment-ref";
import { PreviewToolCard } from "@/components/previews/preview-card";
import { WebFetchCard, WebSearchCard } from "@/components/ai-elements/web-cards";
import { ScreenshotCard } from "@/components/ai-elements/screenshot-card";
import {
  CancelRunCard,
  NoteCard,
  DocsCard,
  PreviewSetupCard,
  ProjectsCard,
  QueryTerminal,
  SkillCard,
} from "@/components/ai-elements/info-cards";
import { PlanDocument, PlanToolCard, PlanViewProvider, quoteBlock, type PlanView } from "@/components/plan-card";
import { DISMISS_ANSWER } from "@/lib/dismiss-answer";
import { derivePhase, isPlanCard, phaseEvents, planHistory, type Phase } from "@/lib/plan";
import { ApprovalEvidenceView } from "@/components/approval-evidence";
import type { ApprovalEvidence } from "@/lib/agent/tools/evidence";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { ToolGroupView } from "@/components/ai-elements/tool-group";
import { groupParts, type PartLike } from "@/lib/tool-groups";
import { HarnessCard } from "@/components/harness-card";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import type { ChatRoute } from "@/lib/providers/route";
import type { ToolState } from "@/lib/machine-tool-view";
import type { ViewingContext } from "@/lib/page-context";
import { hasBackgroundChild, rowsToUIMessages, untilLiveTurn, type StoredRow } from "@/lib/chat-ui";
import { CHAT_STREAM_THROTTLE_MS } from "@/lib/chat-stream-throttle";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import {
  SANDBOXED_TOOLS,
  SandboxChip,
  SandboxViewProvider,
  type ConversationSandboxViewData,
} from "@/components/sandbox-view";

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

/** owner/repo + number read off a PR web URL. */
function prUrlCoords(url: string): { repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: match[3] } : null;
}

/**
 * 0037: a create_pr call waiting on Chad — the runtime's evidence (test
 * check, the thread's screenshots) plus Approve/Deny, right in the
 * transcript. The evidence row appears once the preview step has written
 * it (polled until then); typing in the composer is a revise.
 */
function PendingPRApproval({ toolCallId }: { toolCallId: string }) {
  const [evidence, setEvidence] = useState<ApprovalEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (evidence) return;
    let stop = false;
    const load = async () => {
      const res = await fetch(`/api/x/input?toolCallId=${encodeURIComponent(toolCallId)}`).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { evidence?: ApprovalEvidence | null } | null;
      if (!stop && body?.evidence) setEvidence(body.evidence);
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [toolCallId, evidence]);
  const post = async (approved: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/x/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId, approved }),
      });
      if (res.ok) setAnswered(true);
    } finally {
      setBusy(false);
    }
  };
  if (!evidence) {
    return (
      <p className="px-3 pb-2.5 text-xs text-muted-foreground">Running the project&apos;s checks for the approval card…</p>
    );
  }
  return (
    <div className="space-y-2 border-t border-warning/40 bg-warning/5 px-3 py-2.5">
      <ApprovalEvidenceView evidence={evidence} />
      {answered ? (
        <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Approve PR
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(false)}
            className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Deny
          </button>
          <span className="text-xs text-muted-foreground">or type below to send it back with changes</span>
        </div>
      )}
    </div>
  );
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
              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 pointer-coarse:px-3 pointer-coarse:py-2"
            >
              View PR →
            </a>
          )}
          <CollapsibleTrigger
            aria-label="Toggle create_pr details"
            title="Details"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors pointer-coarse:size-10 hover:bg-accent hover:text-foreground"
          >
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
        </div>
      </div>
      {part.state === "input-available" && <PendingPRApproval toolCallId={part.toolCallId} />}
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

/** An ask_chad call awaiting Chad: approvals get Approve/Deny, questions *  get a freeform answer box — matching what the tool asked for. */
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
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2.5 text-base pointer-coarse:h-10 md:text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) void post({ answer: draft });
              }}
            />
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => void post({ answer: draft })}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
            >
              Answer
            </button>
            <button
              type="button"
              disabled={busy}
              title="Answer with 'carry on without me' — the agent stops waiting"
              onClick={() => void post({ answer: DISMISS_ANSWER })}
              className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ approved: true })}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void post({ approved: false })}
              className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
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

/** 0041: accept_plan waiting on Chad — the plan version it would approve,
 *  with Approve/Deny (typing below answers it as a deny, 0037's rule). */
function AcceptPlanCard({ part }: { part: ToolUIPart }) {
  const [card, setCard] = useState<{ version: number; markdown: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  useEffect(() => {
    if (card) return;
    let stop = false;
    const load = async () => {
      const res = await fetch(`/api/x/input?toolCallId=${encodeURIComponent(part.toolCallId)}`).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { evidence?: unknown } | null;
      if (!stop && isPlanCard(body?.evidence)) setCard(body.evidence);
    };
    void load();
    const timer = window.setInterval(() => void load(), 3_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [part.toolCallId, card]);
  const post = async (approved: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/x/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: part.toolCallId, approved }),
      });
      if (res.ok) setAnswered(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="my-1 space-y-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">{card ? `Approve plan v${card.version}?` : "Approve the plan?"}</p>
      <p className="text-xs text-muted-foreground">You said so in chat — the agent is waiting for an explicit approval.</p>
      {card && (
        <details className="rounded-md border bg-background px-2 py-1.5">
          <summary className="cursor-pointer text-xs text-muted-foreground">Show plan v{card.version}</summary>
          <PlanDocument markdown={card.markdown} className="mt-2" />
        </details>
      )}
      {answered ? (
        <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(false)}
            className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Not yet
          </button>
          <span className="text-xs text-muted-foreground">or type below to say what to change</span>
        </div>
      )}
    </div>
  );
}

/** Tools whose execute asks Chad first (the ask_chad pattern inside a
 * tool): while the part is unresolved, the transcript shows the
 * approval buttons right there — same POST as the inbox card. */
const GATED_TOOLS = new Set(["create_project", "delete_project"]);

/** 0043: an exec call waiting on Chad — approve it right here (the
 *  inbox card posts to the same endpoint); typing below answers it as a
 *  denial with the text as the comment (the 0037 rule). */
function HostExecApprovalCard({ part }: { part: ToolUIPart }) {
  const [busy, setBusy] = useState(false);
  const input = (part.state === "input-streaming" ? undefined : part.input) as
    | { host?: unknown; command?: unknown; description?: unknown; timeout?: unknown }
    | undefined;
  const host = typeof input?.host === "string" ? input.host : undefined;
  const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const timeout = typeof input?.timeout === "number" ? input.timeout : 120;
  const answered = part.state === "output-available" || part.state === "output-error" || part.state === "output-denied";

  const post = async (approved: boolean) => {
    setBusy(true);
    try {
      await fetch("/api/x/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: part.toolCallId, approved }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-1 space-y-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">
        Run on {host ?? "a host"}?
        {description && <span className="ml-1.5 font-normal text-muted-foreground">{description}</span>}
      </p>
      <div className="rounded-md border border-terminal-border bg-terminal px-3 py-2 font-mono text-xs">
        <div className="text-terminal-muted">{timeout}s timeout · every approved command runs via bash -lc as the host&apos;s user</div>
        <pre className="mt-1.5 whitespace-pre-wrap text-terminal-foreground">$ {command ?? "…"}</pre>
      </div>
      {!answered ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(false)}
            className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Deny
          </button>
          <span className="text-xs text-muted-foreground">or type below to send it back with a comment</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>
      )}
    </div>
  );
}

/** One gated tool call awaiting Chad's approval, in the transcript. */
function GatedApprovalCard({ part }: { part: ToolUIPart }) {
  const [busy, setBusy] = useState(false);
  const name = part.type.replace(/^tool-/, "");
  const input = part.state === "input-streaming" ? undefined : (part.input as Record<string, unknown> | undefined);
  const str = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  const headline =
    name === "create_project"
      ? `Create project ${str("id") ?? "?"}${str("name") ? ` ("${str("name")}")` : ""}`
      : `Delete project ${str("id") ?? "?"} — and everything it owns`;
  const answered = part.state === "output-available" || part.state === "output-error";

  const post = async (approved: boolean) => {
    setBusy(true);
    try {
      await fetch("/api/x/input", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId: part.toolCallId, approved }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="my-1 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">{headline}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">The agent is waiting for your approval.</p>
      {!answered ? (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(true)}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post(false)}
            className="rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Deny
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {part.state === "output-available" ? String(part.output).slice(0, 300) : "no answer recorded"}
        </p>
      )}
    </div>
  );
}

const AGENT_TOOLS = new Set([
  "start_thread",
  "inspect",
  "sandbox_exec",
  "exec",
  "start_preview",
  "preview_status",
  "stop_preview",
  "use_skill",
  "system_docs",
  "list_projects",
  "get_preview_setup",
  "save_preview_setup",
  "gh",
  "forgejo",
  "cancel_run",
  "note",
]);

/** The designed card for a machine / run / inspect tool call, if it has one. */
function agentToolCard(part: ToolUIPart): ReactNode {
  const name = part.type.replace(/^tool-/, "");
  if (!AGENT_TOOLS.has(name)) return null;
  const state: ToolState =
    part.state === "output-available" ? "completed" : part.state === "output-error" || part.state === "output-denied" ? "error" : "running";
  const shared = {
    state,
    input: part.state === "input-streaming" ? undefined : part.input,
    output: part.state === "output-available" ? part.output : undefined,
    errorText: part.state === "output-error" ? (part.errorText ?? "tool failed") : part.state === "output-denied" ? "denied" : undefined,
  };
  switch (name) {
    case "start_thread":
      return <StartThreadCard {...shared} />;
    case "inspect":
      return <InspectCard {...shared} />;
    case "sandbox_exec":
      return <SandboxExecCard {...shared} />;
    case "exec":
      return <HostExecCard {...shared} />;
    case "start_preview":
    case "preview_status":
    case "stop_preview":
      return <PreviewToolCard tool={name} {...shared} />;
    case "use_skill":
      return <SkillCard {...shared} />;
    case "system_docs":
      return <DocsCard {...shared} />;
    case "list_projects":
      return <ProjectsCard {...shared} />;
    case "get_preview_setup":
    case "save_preview_setup":
      return <PreviewSetupCard tool={name} {...shared} />;
    case "gh":
    case "forgejo":
      return <QueryTerminal tool={name} {...shared} />;
    case "cancel_run":
      return <CancelRunCard {...shared} />;
    case "note":
      return <NoteCard {...shared} />;
    default:
      return null;
  }
}

/** One tool call, collapsed by default. */
const ToolCallView = ({ part }: { part: ToolUIPart }) => {
  const input = part.state === "input-streaming" ? undefined : part.input;
  const output = part.state === "output-available" ? part.output : undefined;
  const errorText = part.state === "output-error" ? (part.errorText ?? "tool failed") : undefined;
  const toolName = part.type.replace(/^tool-/, "");
  if (toolName === "bash") {
    return (
      <BashTerminal
        className="my-1"
        state={part.state}
        input={input}
        output={output}
        errorText={errorText}
        extra={<SandboxChip />}
      />
    );
  }
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={part.type.replace(/^tool-/, "")}
        extra={
          SANDBOXED_TOOLS.has(part.type.replace(/^tool-/, "")) ? (
            <SandboxChip />
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

/** The "Chad is viewing …" chip on a user message (0015 page context). */
function ViewingChip({ viewing }: { viewing: ViewingContext }) {
  return (
    <span className="mb-1 inline-flex max-w-full items-center gap-1 self-start rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      <Eye className="size-3 shrink-0" aria-hidden />
      <span className="truncate">
        viewing {viewing.kind}
        {viewing.title ? ` ${viewing.title}` : ""}
        {viewing.selection ? ` · ${viewing.selection}` : ""}
      </span>
    </span>
  );
}

/** The "[run finished]" chip on a wake message (0022) — marks the user
 * row as machine-delivered, never Chad's own words. */
function RunEventChip({ runEvent }: { runEvent: { kind: string; id: string; status: string } }) {
  return (
    <span className="mb-1 inline-flex max-w-full items-center gap-1 self-start rounded-full border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
      <span className="truncate">
        {runEvent.kind === "budget"
          ? "step budget reached · continuing"
          : runEvent.kind === "plan"
          ? `plan ${runEvent.status}`
          : `${runEvent.kind === "machine" ? "run" : runEvent.kind === "thread" ? "thread" : runEvent.id.split("_")[0]} ${runEvent.status} · ${runEvent.id}`}
      </span>
    </span>
  );
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
  const viewing = (message.metadata as { viewing?: ViewingContext } | undefined)?.viewing;
  const runEvent = (
    message.metadata as { runEvent?: { kind: string; id: string; status: string } } | undefined
  )?.runEvent;

  const renderPart = (part: (typeof message.parts)[number], i: number): ReactNode => {
          if (part.type === "text") {
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type.startsWith("tool-")) {
            const toolPart = part as ToolUIPart;
            if (toolPart.type === "tool-ask_chad") return <AskChadCard key={i} part={toolPart} />;
            if (toolPart.type === "tool-pi" || toolPart.type === "tool-claude" || toolPart.type === "tool-cursor") {
              const task = (toolPart.input as { task?: unknown } | undefined)?.task;
              return (
                <HarnessCard
                  key={i}
                  kind={toolPart.type.slice(5)}
                  state={toolPart.state}
                  task={typeof task === "string" ? task : undefined}
                  output={toolPart.state === "output-available" ? toolPart.output : undefined}
                  errorText={toolPart.state === "output-error" ? toolPart.errorText : undefined}
                  conversationId={conversationId ?? null}
                />
              );
            }
            if (toolPart.type === "tool-create_pr") {
              return <PullRequestToolCard key={i} part={toolPart} />;
            }
            // 0041: the plan document and its chat-approval gate.
            if (toolPart.type === "tool-present_plan") {
              return (
                <PlanToolCard
                  key={i}
                  toolCallId={toolPart.toolCallId}
                  state={toolPart.state}
                  output={toolPart.state === "output-available" ? toolPart.output : undefined}
                  errorText={toolPart.state === "output-error" ? (toolPart.errorText ?? "tool failed") : undefined}
                />
              );
            }
            if (toolPart.type === "tool-accept_plan" && toolPart.state === "input-available") {
              return <AcceptPlanCard key={i} part={toolPart} />;
            }
            // 0043: exec approves inline — the buttons live in the
            // transcript while the call awaits Chad; once answered the
            // terminal card renders the outcome.
            if (
              toolPart.type === "tool-exec" &&
              toolPart.state !== "output-available" &&
              toolPart.state !== "output-error" &&
              toolPart.state !== "output-denied"
            ) {
              return <HostExecApprovalCard key={i} part={toolPart} />;
            }
            // Gated tools (0033): the approval buttons live in the
            // transcript while the call awaits Chad; once answered the
            // normal card renders the outcome.
            if (
              GATED_TOOLS.has(toolPart.type.replace(/^tool-/, "")) &&
              toolPart.state !== "output-available" &&
              toolPart.state !== "output-error"
            ) {
              return <GatedApprovalCard key={i} part={toolPart} />;
            }
            if (toolPart.type === "tool-attach_screenshot") {
              return (
                <ScreenshotCard
                  key={i}
                  state={toolPart.state}
                  input={toolPart.state === "input-streaming" ? undefined : toolPart.input}
                  output={toolPart.state === "output-available" ? toolPart.output : undefined}
                  errorText={toolPart.state === "output-error" ? (toolPart.errorText ?? "tool failed") : undefined}
                />
              );
            }
            if (toolPart.type === "tool-web_search" || toolPart.type === "tool-web_fetch") {
              const input = toolPart.state === "input-streaming" ? undefined : toolPart.input;
              const output = toolPart.state === "output-available" ? toolPart.output : undefined;
              const errorText =
                toolPart.state === "output-error" ? (toolPart.errorText ?? "tool failed") : undefined;
              return toolPart.type === "tool-web_search" ? (
                <WebSearchCard key={i} state={toolPart.state} input={input} output={output} errorText={errorText} />
              ) : (
                <WebFetchCard key={i} state={toolPart.state} input={input} output={output} errorText={errorText} />
              );
            }
            const agentCard = agentToolCard(toolPart);
            if (agentCard) return <Fragment key={i}>{agentCard}</Fragment>;
            return <ToolCallView key={i} part={toolPart} />;
          }
          return null;
  };

  return (
    <Message from={message.role}>
      {viewing && message.role === "user" && <ViewingChip viewing={viewing} />}
      {runEvent && message.role === "user" && <RunEventChip runEvent={runEvent} />}
      <MessageContent>
        <MessageImages parts={message.parts} />
        {groupParts(message.parts as PartLike[]).map((seg) =>
          seg.kind === "group" ? (
            <ToolGroupView
              key={`g${seg.index}`}
              group={seg}
              render={(entry) => renderPart(message.parts[entry.index]!, entry.index)}
            />
          ) : (
            renderPart(message.parts[seg.index]!, seg.index)
          ),
        )}
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

/** 0042: a user message's images, above its text — click opens full size. */
function MessageImages({ parts }: { parts: UIMessage["parts"] }) {
  const images = parts.filter((part): part is FileUIPart => part.type === "file" && part.mediaType.startsWith("image/"));
  if (images.length === 0) return null;
  const many = images.length > 1;
  return (
    <div className={many ? "grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" : "flex"}>
      {images.map((image, i) => (
        <a key={i} href={image.url} target="_blank" rel="noreferrer" className="block min-w-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- our own attachment route, not the image optimizer */}
          <img
            src={image.url}
            alt={image.filename ?? "attached image"}
            className={
              many
                ? "aspect-square w-full rounded-md border border-border object-cover sm:size-40"
                : "max-h-72 w-auto max-w-full rounded-md border border-border object-contain"
            }
          />
        </a>
      ))}
    </div>
  );
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
  // 0041: an open plan review also wakes this chat (on Approve), so the
  // page watches for it the same way.
  const plans = useMemo(() => planHistory(messages), [messages]);
  const phase = useMemo(() => derivePhase(phaseEvents(messages)), [messages]);
  const awaitingWake =
    (adopted || selfAdopted) && !isBusy && (hasBackgroundChild(messages) || plans.openReviewId !== null);
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
    phase,
  };

  // 0041: Quote — a plan selection lands in the composer as a `>` block.
  const planView = useMemo<PlanView>(() => ({
    history: plans,
    quote: (selection) => {
      const el = textareaRef.current;
      if (!el) return;
      const before = el.value.trimEnd();
      el.value = `${before ? `${before}\n\n` : ""}${quoteBlock(selection)}`;
      if (el.value.trim()) window.localStorage.setItem(draftKey, el.value);
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
  }), [plans, draftKey]);
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
                icon={<MessageSquarePlus className="size-6" />}
                title="sweatshop"
                description="A conversation with your agent. Say anything to begin."
              />
            )
          )}
          <SandboxViewProvider value={sandboxView}>
          <PlanViewProvider value={planView}>
          {messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              conversationId={adoptedNow ? conversationId : null}
            />
          ))}
          </PlanViewProvider>
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
