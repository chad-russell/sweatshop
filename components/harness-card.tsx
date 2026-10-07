"use client";

import { ArrowUpRightIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { HARNESS_LABEL, HarnessLogo } from "@/components/harness-logo";
import { SandboxChip } from "@/components/sandbox-view";
import { summarizeActivity, type HarnessActivity, type TimelineEvent } from "@/lib/harness-timeline";
import { cn } from "@/lib/utils";

export type HarnessCardState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
  | "approval-requested"
  | "approval-responded";

interface HarnessResult {
  text?: string;
  toolCalls?: number;
}

/** 0022: the async starter's result — the handle, not the outcome. */
interface HarnessBackground {
  ok: true;
  callId: string;
  eventsUrl: string;
  note: string;
}

interface HarnessBusyError {
  ok: false;
  code: string;
  message: string;
}

const POLL_MS = 2000;

/** While a delegation runs, peek at the harness's newest events. */
function useLiveActivity(conversationId: string | null, kind: string, active: boolean) {
  const [activity, setActivity] = useState<HarnessActivity | null>(null);
  useEffect(() => {
    if (!active || !conversationId) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/harness/${conversationId}?harness=${kind}&tail=60`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const body = (await res.json()) as { events: TimelineEvent[] };
        if (!stop) setActivity(summarizeActivity(body.events));
      } catch {
        /* transient — the next tick retries */
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [conversationId, kind, active]);
  return activity;
}

function StatusPill({ tone, label }: { tone: "running" | "ok" | "fail"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        tone === "running" && "border-info/30 bg-info/10 text-info",
        tone === "ok" && "border-success/30 bg-success/10 text-success",
        tone === "fail" && "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone === "running" && "animate-pulse")} />
      {label}
    </span>
  );
}

/** Text clamped to roughly `lines` lines, with a fade and a Show more / less
 *  toggle that only appears when something is actually hidden. (A max-height
 *  clamp, not -webkit-line-clamp: scrollHeight is reliable for it.) */
export function Clamped({ children, lines = 3, className }: { children: ReactNode; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 2 || open);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, children]);

  return (
    <div className={className}>
      <div
        ref={box}
        className={cn("relative overflow-hidden", !open && overflowing && "[mask-image:linear-gradient(to_bottom,black_65%,transparent)]")}
        style={open ? undefined : { maxHeight: `${lines * 1.625}em` }}
      >
        {children}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
          <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** A handed-over task (chat tool input, or a stage's instructions) as a
 *  quiet, clamped quote. */
export function TaskQuote({ children, className }: { children: string; className?: string }) {
  return (
    <Clamped className={cn("border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground", className)}>
      <p className="whitespace-pre-wrap break-words">{children}</p>
    </Clamped>
  );
}

/** While a harness works: the tool it is running, polled from its newest
 *  events. Renders nothing when not `active`. */
export function HarnessLiveLine({
  conversationId,
  kind,
  active,
  className,
}: {
  conversationId: string | null;
  kind: string;
  active: boolean;
  className?: string;
}) {
  const activity = useLiveActivity(conversationId, kind, active);
  if (!active) return null;
  const calls = activity?.toolCalls ?? 0;
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" />
      {activity?.current ? (
        <>
          <span className="shrink-0 text-foreground">{activity.current.toolName}</span>
          <span className="min-w-0 truncate">{activity.current.brief}</span>
        </>
      ) : activity?.last ? (
        <span className="min-w-0 truncate">thinking… after {activity.last.toolName}</span>
      ) : (
        <span>starting…</span>
      )}
      {calls > 0 && <span className="ml-auto shrink-0">{plural(calls, "tool call")}</span>}
    </div>
  );
}

/** A harness's final summary, clamped with a toggle. */
export function HarnessSummary({ children, className }: { children: string; className?: string }) {
  return (
    <Clamped lines={6} className={cn("text-sm", className)}>
      <MessageResponse>{children}</MessageResponse>
    </Clamped>
  );
}

/**
 * One coding-harness delegation (the chat's `pi` / `claude` tool): the
 * harness's mark and name, a status pill, the task as given, a live line
 * naming the tool it is running while it works, and — when done — its
 * summary and tool-call count. Links to the full /h/<kind>/<id> session.
 */
export function HarnessCard({
  kind,
  state,
  task,
  output,
  errorText,
  conversationId,
}: {
  kind: string;
  state: HarnessCardState;
  task?: string;
  output?: unknown;
  errorText?: string;
  conversationId: string | null;
}) {
  const running = state === "input-streaming" || state === "input-available" || state === "approval-responded";
  const failed = state === "output-error" || state === "output-denied";
  const result = (output && typeof output === "object" ? output : undefined) as
    | HarnessResult
    | HarnessBackground
    | HarnessBusyError
    | undefined;
  // 0022: the tool returning means the call STARTED (or could not) — the
  // outcome arrives later as the wake message; /h/… is the live view.
  const background = result && "callId" in result ? result : undefined;
  const busyError = result && "code" in result ? result : undefined;
  const url = conversationId ? `/h/${kind}/${conversationId}` : null;
  const label = HARNESS_LABEL[kind] ?? kind;
  const summary = result && "text" in result ? result.text?.trim() : undefined;

  const calls = result && "toolCalls" in result ? result.toolCalls : undefined;
  const showFailed = failed || busyError != null;

  return (
    <div
      className={cn(
        "my-1 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        showFailed ? "border-destructive/40" : "border-border",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <HarnessLogo kind={kind} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{label}</span>
          {background ? (
            <StatusPill tone="running" label="in background" />
          ) : (
            <StatusPill
              tone={showFailed ? "fail" : running ? "running" : "ok"}
              label={
                state === "output-denied" ? "denied" : showFailed ? "failed" : running ? "working" : "done"
              }
            />
          )}
          <SandboxChip />
        </div>
        {url && (
          <Link
            href={url}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            Session
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </Link>
        )}
      </div>

      {/* Task, as handed over */}
      {task && (
        <div className="px-3 pb-2.5">
          <TaskQuote>{task}</TaskQuote>
        </div>
      )}

      {/* Live: what it is doing now (synchronous stage calls; the chat's
       * background calls live on the session page instead — 0022). */}
      <HarnessLiveLine conversationId={conversationId} kind={kind} active={running && !background} />

      {/* Background: the handle and what happens next */}
      {background && (
        <div className="border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          <span className="text-foreground">{background.callId}</span> — the result arrives in this
          conversation when it finishes; the Session link above is the live view.
        </div>
      )}

      {/* Done: its summary */}
      {!running && !showFailed && summary && (
        <div className="border-t border-border px-3 py-2.5">
          <HarnessSummary>{summary}</HarnessSummary>
        </div>
      )}
      {!running && !showFailed && (calls ?? 0) > 0 && (
        <div className="border-t border-border bg-muted/30 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {plural(calls ?? 0, "tool call")}
        </div>
      )}

      {/* Failed */}
      {showFailed && (
        <p className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {busyError?.message ?? errorText ?? "harness call failed"}
        </p>
      )}
    </div>
  );
}
