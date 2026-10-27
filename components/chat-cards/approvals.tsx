"use client";

import { conversationLabel } from "@/lib/conversation-label";
import { Fragment, useState } from "react";
import type { ToolUIPart } from "ai";
import { ChevronDown, GitPullRequest } from "lucide-react";
import { Tool, ToolContent, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { MessageResponse } from "@/components/ai-elements/message";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { OutlineDocument } from "@/components/outline-card";
import { QuestionForm } from "@/components/question-form";
import { DISMISS_ANSWER } from "@/lib/dismiss-answer";
import { isOutlineCard, type OutlineCard } from "@/lib/outline";
import { isAskOwnerCard, type AskOwnerCard as AskOwnerCardData, type QuestionAnswer } from "@/lib/question-form";
import { usePRStates } from "@/lib/use-pr-states";
import { ApprovalEvidenceView } from "@/components/approval-evidence";
import type { ApprovalEvidence } from "@/lib/agent/tools/evidence";
import { DiffBreakdownChip } from "@/components/diff-breakdown";
import { isDiffBreakdown } from "@/lib/diff-breakdown";
import { prUrlCoords } from "@/lib/work-prs";
import { useAnswerPendingInput, usePendingInputCard } from "@/lib/use-pending-input";
import { cn } from "@/lib/utils";
import type { PromptChangeCard as PromptChangeCardData } from "@/lib/read-models/attention";

/**
 * Approval-gated transcript cards (create_pr, ask_owner, exec,
 * gated tools) — split from chat-session.tsx. The evidence polling and
 * the answering both go through lib/use-pending-input.ts; each card
 * only owns its predicate on the pending_inputs row's evidence.
 */

/** 0037 kept the create_pr evidence an unvalidated truthiness cast —
 *  the row is written by our own runtime — so the poll guard stays one. */
const hasEvidence = (value: unknown): boolean => Boolean(value);

/** A pending_inputs evidence row is this card's data iff it carries the
 *  prompt_change kind (the proposal's immutable snapshot). */
const isPromptChangeCard = (value: unknown): boolean =>
  (value as Partial<PromptChangeCardData> | undefined)?.kind === "prompt_change";

/**
 * 0037: a create_pr call waiting on Chad — the runtime's evidence (test
 * check, the thread's screenshots) plus Approve/Deny, right in the
 * transcript. The evidence row appears once the preview step has written
 * it (polled until then); typing in the composer is a revise.
 */
export function PendingPRApproval({ toolCallId }: { toolCallId: string }) {
  const evidence = usePendingInputCard<ApprovalEvidence>(toolCallId, hasEvidence);
  const { answered, busy, post } = useAnswerPendingInput(toolCallId);
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
            onClick={() => void post({ approved: true })}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 pointer-coarse:px-4 pointer-coarse:py-2.5 pointer-coarse:text-sm"
          >
            Approve PR
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void post({ approved: false })}
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

/**
 * One create_pr call: status pill, title, branch chips, link out. Once
 * a PR URL exists the pill follows the host's live answer (0052): open
 * (or unknown pre-first-response) shows "opened", merged shows "merged",
 * closed shows "closed" — the tool result's own text stays as it was.
 */
export function PullRequestToolCard({ part }: { part: ToolUIPart }) {
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
      ? (part.output as { url?: unknown; number?: unknown; breakdown?: unknown } | undefined)
      : undefined;
  const url = typeof output?.url === "string" ? output.url : undefined;
  const prNumber = typeof output?.number === "number" ? output.number : undefined;
  const breakdown = isDiffBreakdown(output?.breakdown) ? output.breakdown : undefined;
  // 0052: the host's live answer (settled PRs stop polling on their own).
  const prStates = usePRStates(url ? [url] : null);
  const live = url ? prStates[url] ?? null : null;
  const closed = !running && !failed && live?.state === "closed";
  const merged = !running && !failed && live?.state === "merged";
  const coords = url ? prUrlCoords(url) : null;
  const numberText = coords?.number ?? (prNumber !== undefined ? String(prNumber) : undefined);
  const errorText = failed ? (part.errorText ?? "create_pr failed") : undefined;
  const stateWord = failed ? "failed" : running ? "opening" : closed ? "closed" : merged ? "merged" : "open";
  const stateDot = failed ? "bg-destructive" : running ? "bg-info" : closed ? "bg-muted-foreground" : "bg-success";
  const iconClass = failed ? "text-destructive" : running ? "text-info" : closed ? "text-muted-foreground" : "text-success";

  return (
    <Tool className={cn("my-1", failed && "border-destructive/40")}>
      {/* 0078: one slim line — the detail (body, branches, breakdown)
       *  lives in the collapsible below. */}
      <div className="flex w-full items-center gap-2 px-3 py-2.5 text-sm">
        <GitPullRequest className={cn("size-4 shrink-0", iconClass)} aria-hidden />
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", stateDot, running && "animate-pulse")} />
        <span className="shrink-0 text-xs text-muted-foreground">{stateWord}</span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {title ?? (running ? "Opening pull request…" : "Pull request")}
        </span>
        {(coords?.repo || numberText) && (
          <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:inline">
            {[coords?.repo, numberText && `#${numberText}`].filter(Boolean).join(" ")}
          </span>
        )}
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 pointer-coarse:px-3 pointer-coarse:py-2"
          >
            View PR →
          </a>
        )}
        <CollapsibleTrigger
          aria-label="Toggle create_pr details"
          title="Details"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors pointer-coarse:size-10 hover:bg-accent hover:text-foreground"
        >
          <ChevronDown
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
      </div>
      {part.state === "input-available" && <PendingPRApproval toolCallId={part.toolCallId} />}
      <ToolContent>
        {head && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{head}</span>
            <span aria-hidden>→</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{base}</span>
            {!coords?.repo && repoDir && <span className="font-mono">{repoDir}</span>}
            {breakdown && <DiffBreakdownChip breakdown={breakdown} />}
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

/**
 * An ask_owner call awaiting the owner. 0081: a structured ask (the tool
 * call's own `questions` input — visible before the resolved card even
 * loads) renders the shared QuestionForm once its resolved card (with
 * screenshot evidence turned into attachment URLs) arrives from
 * `/api/x/input`; a legacy/plain ask keeps the freeform box. Approvals
 * are untouched (approve/deny + comment); Dismiss always posts the
 * legacy `{answer: DISMISS_ANSWER}` shape, structured or not.
 */
export function AskOwnerCard({ part }: { part: ToolUIPart }) {
  const [draft, setDraft] = useState("");
  const answered = part.state === "output-available" || part.state === "output-error";
  // Poll only while the part is unresolved — the resolved card outlives
  // its pending_inputs row, and the part's own state is the answer.
  const card = usePendingInputCard<AskOwnerCardData>(part.toolCallId, isAskOwnerCard, !answered);
  const { busy, post } = useAnswerPendingInput(part.toolCallId);
  const input = part.input as { kind?: unknown; question?: unknown; questions?: unknown } | undefined;
  const kind = input?.kind === "question" ? "question" : "approval";
  const question = typeof input?.question === "string" ? input.question : undefined;
  const structured = Array.isArray(input?.questions) && input.questions.length > 0;

  const contextBlock = !structured && card?.context && (
    <details className="mt-1.5 rounded-md border border-border bg-background px-2 py-1.5">
      <summary className="cursor-pointer text-xs text-muted-foreground">Why I&apos;m asking</summary>
      <div className="mt-1.5 text-sm">{card.context}</div>
    </details>
  );

  return (
    <div className="my-1 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">
        {kind === "question" ? "Question for you: " : "Approve? "}
        {question}
      </p>
      {!answered && structured && (
        card ? (
          <div className="mt-2 space-y-2">
            <QuestionForm card={card} busy={busy} onSubmit={(answers: Record<string, QuestionAnswer>) => void post({ answers })} />
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
          <p className="mt-2 text-xs text-muted-foreground">Loading the question…</p>
        )
      )}
      {!answered && !structured && (
        kind === "question" ? (
          <div className="mt-2 flex flex-col gap-2">
            {contextBlock}
            <div className="flex gap-2">
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
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            {contextBlock}
            <div className="flex gap-2">
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
          </div>
        )
      )}
      {answered && (
        <MessageResponse className="mt-1 text-xs text-muted-foreground">
          {part.state === "output-available" ? answerText(part.output) : "no answer recorded"}
        </MessageResponse>
      )}
    </div>
  );
}

/** Accept an outline after the owner explicitly approves it. */
export function AcceptOutlineCard({ part }: { part: ToolUIPart }) {
  const card = usePendingInputCard<OutlineCard>(part.toolCallId, isOutlineCard);
  const { answered, busy, post } = useAnswerPendingInput(part.toolCallId);
  return (
    <div className="my-1 space-y-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">{card ? `Approve outline v${card.version}?` : "Approve the outline?"}</p>
      <p className="text-xs text-muted-foreground">You said so in chat — the agent is waiting for an explicit approval.</p>
      {card && (
        <details className="rounded-md border bg-background px-2 py-1.5">
          <summary className="cursor-pointer text-xs text-muted-foreground">Show outline v{card.version}</summary>
          <OutlineDocument outline={card.outline} className="mt-2" />
        </details>
      )}
      {answered ? (
        <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
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
 * approval buttons right there — same POST as the inbox card. 0055:
 * no new card kind. */
export const GATED_TOOLS = new Set(["create_project", "delete_project"]);

export function PromptChangeDetails({ card }: { card: PromptChangeCardData }) {
  const fields = (["description", "thread", "status"] as const).filter((key) => key in card.patch);
  const value = (v: unknown) => typeof v === "boolean" ? String(v) : v == null ? "(unset)" : String(v);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{card.title}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">
          based on v{card.currentVersion}
        </span>
      </div>
      {fields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border bg-background p-2 text-xs">
          {fields.map((key) => (
            <Fragment key={key}>
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words">
                <span className="text-destructive line-through">{value(card.before?.[key])}</span>
                <span className="px-1.5" aria-hidden>→</span>
                <span className="text-success">{value(card.patch[key])}</span>
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {card.affectedThreads && card.affectedThreads.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
          <p className="font-medium">Currently running bound threads</p>
          <ul className="mt-1 space-y-0.5 font-mono text-muted-foreground">
            {card.affectedThreads.map((thread) => (
              <li key={thread.id}>{conversationLabel({ title: thread.title })} · {thread.id}</li>
            ))}
          </ul>
          <p className="mt-1 text-muted-foreground">They keep using this skill; the status only affects new bindings.</p>
        </div>
      )}
      {card.diff && (
        <pre className="max-h-[32rem] overflow-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap break-words">
          {card.diff.map((line, index) => (
            <span
              key={index}
              className={cn(
                "block min-h-[1lh]",
                line.op === "add" && "bg-success/10 text-success",
                line.op === "del" && "bg-destructive/10 text-destructive",
                line.op === "same" && "text-muted-foreground",
              )}
            >
              {line.op === "add" ? "+" : line.op === "del" ? "-" : " "} {line.text}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

/** The complete immutable proposal snapshot, fetched from pending_inputs. */
export function PromptChangeApprovalCard({ part }: { part: ToolUIPart }) {
  const card = usePendingInputCard<PromptChangeCardData>(part.toolCallId, isPromptChangeCard);
  const { busy, post } = useAnswerPendingInput(part.toolCallId);
  const answered = part.state === "output-available" || part.state === "output-error";
  return (
    <div className="my-1 space-y-3 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      {card ? <PromptChangeDetails card={card} /> : <p className="text-xs text-muted-foreground">Loading the proposed change…</p>}
      {!answered ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || !card}
            onClick={() => void post({ approved: true })}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            Approve change
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
      ) : <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>}
    </div>
  );
}

/** 0043: an exec call waiting on Chad — approve it right here (the
 *  inbox card posts to the same endpoint); typing below answers it as a
 *  denial with the text as the comment (the 0037 rule). */
export function HostExecApprovalCard({ part }: { part: ToolUIPart }) {
  const { busy, post } = useAnswerPendingInput(part.toolCallId);
  const input = (part.state === "input-streaming" ? undefined : part.input) as
    | { host?: unknown; command?: unknown; description?: unknown; timeout?: unknown }
    | undefined;
  const host = typeof input?.host === "string" ? input.host : undefined;
  const description = typeof input?.description === "string" && input.description.trim() ? input.description.trim() : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  const timeout = typeof input?.timeout === "number" ? input.timeout : 120;
  const answered = part.state === "output-available" || part.state === "output-error" || part.state === "output-denied";

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
          <span className="text-xs text-muted-foreground">or type below to send it back with a comment</span>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Answered — the agent continues.</p>
      )}
    </div>
  );
}

/** One gated tool call awaiting Chad's approval, in the transcript. */
export function GatedApprovalCard({ part }: { part: ToolUIPart }) {
  const { busy, post } = useAnswerPendingInput(part.toolCallId);
  const name = part.type.replace(/^tool-/, "");
  const input = part.state === "input-streaming" ? undefined : (part.input as Record<string, unknown> | undefined);
  const str = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  const headline =
    name === "create_project"
      ? `Create project ${str("id") ?? "?"}${str("name") ? ` ("${str("name")}")` : ""}`
      : name === "delete_project"
        ? `Delete project ${str("id") ?? "?"} — and everything it owns`
        : name.replaceAll("_", " ");
  const answered = part.state === "output-available" || part.state === "output-error";

  return (
    <div className="my-1 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2.5 text-card-foreground">
      <p className="text-sm font-medium">{headline}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{str("reason") ?? "The agent is waiting for your approval."}</p>
      {!answered ? (
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
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          {part.state === "output-available" ? answerText(part.output) : "no answer recorded"}
        </p>
      )}
    </div>
  );
}

/** A gated tool's resolved output for display: its own `message` when
 *  it has one (a denial's comment, a plain string), else a clipped
 *  JSON dump — never the bare `[object Object]` `String()` gives an
 *  object. */
function answerText(output: unknown): string {
  if (typeof output === "string") return output.slice(0, 300);
  const message = (output as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : JSON.stringify(output);
  return text.slice(0, 300);
}
