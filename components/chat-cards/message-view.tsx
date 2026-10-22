"use client";

import { Check, Copy, Eye } from "lucide-react";
import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { FileUIPart, ToolUIPart, UIMessage } from "ai";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { HarnessCard } from "@/components/harness-card";
import { PhaseContextBlock } from "@/components/phase-context";
import { PlanToolCard } from "@/components/plan-card";
import { OutlineToolCard } from "@/components/outline-card";
import { splitPhaseHandoff } from "@/lib/agent/mode-ids";
import { ScreenshotCard } from "@/components/ai-elements/screenshot-card";
import { WebFetchCard, WebSearchCard } from "@/components/ai-elements/web-cards";
import {
  AskOwnerCard,
  AcceptOutlineCard,
  AcceptPlanCard,
  HostExecApprovalCard,
  GatedApprovalCard,
  GATED_TOOLS,
  PullRequestToolCard,
  PromptChangeApprovalCard,
} from "./approvals";
import { agentToolCard, ToolCallView } from "./dispatch";
import { ToolGroupView } from "@/components/ai-elements/tool-group";
import { groupParts, type PartLike } from "@/lib/tool-views/groups";
import type { ViewingContext } from "@/lib/page-context";
import { useMounted } from "@/lib/use-mounted";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * Per-message transcript rendering — the AI Elements message shell, the
 * part-type switch (text, tool calls, images, chips) — split from
 * chat-session.tsx.
 */

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
          : runEvent.kind === "outline"
          ? `outline ${runEvent.status}`
          : runEvent.kind === "outline-edit"
          ? "Chad edited the outline"
          : runEvent.kind === "mode"
          ? `Entered ${runEvent.id} mode`
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
            if (runEvent?.kind === "outline-edit") return null;
            if (message.role === "user") {
              const handoff = splitPhaseHandoff(part.text);
              if (handoff) {
                return (
                  <div key={i}>
                    <PhaseContextBlock phase={handoff.phase} text={handoff.context} className="mb-2 rounded-lg border border-border" />
                    {handoff.task.trim() && <MessageResponse>{handoff.task}</MessageResponse>}
                  </div>
                );
              }
            }
            return <MessageResponse key={i}>{part.text}</MessageResponse>;
          }
          if (part.type.startsWith("tool-")) {
            const toolPart = part as ToolUIPart;
            if (toolPart.type === "tool-ask_owner" || toolPart.type === "tool-ask_chad")
              return <AskOwnerCard key={i} part={toolPart} />;
            if (
              toolPart.type === "tool-pi" ||
              toolPart.type === "tool-claude" ||
              toolPart.type === "tool-cursor" ||
              toolPart.type === "tool-codex"
            ) {
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
            if (toolPart.type === "tool-propose_prompt_change") {
              return <PromptChangeApprovalCard key={i} part={toolPart} />;
            }
            // 0064: the outline card — also renders a legacy update_status
            // result read-only (0064 decision 10).
            if (toolPart.type === "tool-update_outline" && toolPart.state === "output-available") {
              return (
                <OutlineToolCard
                  key={i}
                  toolCallId={toolPart.toolCallId}
                  toolName="update_outline"
                  state={toolPart.state}
                  output={toolPart.output}
                />
              );
            }
            if (toolPart.type === "tool-update_status" && toolPart.state === "output-available") {
              return (
                <OutlineToolCard
                  key={i}
                  toolCallId={toolPart.toolCallId}
                  toolName="update_status"
                  state={toolPart.state}
                  output={toolPart.output}
                />
              );
            }
            if (toolPart.type === "tool-accept_outline" && toolPart.state === "input-available") {
              return <AcceptOutlineCard key={i} part={toolPart} />;
            }
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
