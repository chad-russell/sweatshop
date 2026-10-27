"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleXIcon,
  FlagIcon,
  GitForkIcon,
  HandIcon,
  Loader2Icon,
  MinusIcon,
  PencilLineIcon,
  PlayIcon,
  PlusIcon,
  SearchCodeIcon,
  UnplugIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { BashTerminal } from "@/components/ai-elements/bash-terminal";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HarnessMark } from "@/components/harness-logo";
import { objectOf } from "@/lib/tool-views/fields";
import { execOf, failureOf, inspectName, inspectOf, inspectState, oneLine, transitionOf, type InspectView, type ToolState } from "@/lib/tool-views/inspect";
import type { ChildStatus } from "@/lib/child-status";
import { elapsed, useChildStatus } from "@/lib/use-child-status";
import { cn } from "@/lib/utils";

// --- shell --------------------------------------------------------------------

type Tone = "running" | "ok" | "fail" | "warn" | "neutral";

export function Pill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        tone === "running" && "border-info/30 bg-info/10 text-info",
        tone === "ok" && "border-success/30 bg-success/10 text-success",
        tone === "fail" && "border-destructive/30 bg-destructive/10 text-destructive",
        tone === "warn" && "border-warning/30 bg-warning/10 text-warning",
        tone === "neutral" && "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full bg-current", tone === "running" && "animate-pulse")} />
      {label}
    </span>
  );
}

/** The shared look: header (icon · title · subtitle · pill · extra), optional
 *  collapsible body, optional failure strip. */
export function Card({
  icon: Icon,
  title,
  subtitle,
  tone,
  pill,
  extra,
  link,
  failed,
  errorLines,
  defaultOpen = false,
  children,
  className,
}: {
  icon: LucideIcon;
  title: ReactNode;
  subtitle?: ReactNode;
  tone: Tone;
  /** Omit for a default-tone card with nothing worth flagging (0079). */
  pill?: string;
  extra?: ReactNode;
  link?: { href: string; label: string };
  failed?: boolean;
  errorLines?: string[];
  defaultOpen?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasBody = Boolean(children);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose my-1 w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        failed ? "border-destructive/40" : "border-border",
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{title}</span>
          {subtitle && <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{subtitle}</span>}
        </div>
        {extra}
        {pill && <Pill tone={tone} label={pill} />}
        {link && (
          <Link
            href={link.href}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            {link.label}
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </Link>
        )}
        {hasBody && (
          <CollapsibleTrigger
            aria-label={open ? "Hide details" : "Show details"}
            className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        )}
      </div>
      {hasBody && (
        <CollapsibleContent>
          <div className="border-t border-border bg-muted/30">{children}</div>
        </CollapsibleContent>
      )}
      {errorLines && errorLines.length > 0 && (
        <ul className="space-y-0.5 border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] text-destructive">
          {errorLines.map((line, i) => (
            <li key={i} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
    </Collapsible>
  );
}

export const statePill = (state: ToolState, failed: boolean): { tone: Tone; pill: string } =>
  failed ? { tone: "fail", pill: "failed" } : state === "running" ? { tone: "running", pill: "running" } : { tone: "ok", pill: "done" };

/** The pill for a background child's own status (0022 runs / calls). */
export function childPill(s: ChildStatus): { tone: Tone; pill: string } {
  switch (s.status) {
    case "running":
      return { tone: "running", pill: "running" };
    case "waiting":
      return { tone: "warn", pill: "waiting on you" };
    case "needs-attention":
      return { tone: "warn", pill: "needs attention" };
    case "completed":
      return { tone: "ok", pill: "completed" };
    case "failed":
      return { tone: "fail", pill: "failed" };
    case "cancelled":
      return { tone: "neutral", pill: "cancelled" };
    default:
      return { tone: "neutral", pill: s.status };
  }
}

/** 0055 v7 PR2: a background child's work chip — `<phase> · <harness or
 *  skill>` (whichever applies) plus elapsed time, ticking while live,
 *  frozen once settled. `kind` is the harness name for a harness call;
 *  threads fall back to the skill, shown only while live (settled, the
 *  card's own subtitle already names it). */
export function ChildMeta({ status, kind }: { status: ChildStatus; kind?: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status.live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status.live]);
  const end = status.live ? now : (status.settledAt ?? now);
  const label = kind ?? (status.where && status.live ? status.where : null);
  return (
    <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
      {status.phase && (
        <>
          <span className="text-foreground">{status.phase}</span>
          <span aria-hidden>·</span>
        </>
      )}
      {label && (
        <>
          <span>{label}</span>
          <span aria-hidden>·</span>
        </>
      )}
      <span>{elapsed(status.startedAt, end)}</span>
    </span>
  );
}

/** Failure lines for a card: the tool's own `ok:false` (with its issues) or a thrown error. */
export function failureLines(output: unknown, errorText?: string): string[] | undefined {
  const f = failureOf(output);
  if (f) return [f.message, ...f.issues];
  return errorText ? [errorText] : undefined;
}

function MetaChip({ children }: { children: ReactNode }) {
  return <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">{children}</span>;
}

// --- cards ---------------------------------------------------------------------

/** A started child thread (start_thread): the handle to poll/follow. */
function threadStarted(
  output: unknown,
): { id: string; url: string; sandbox: string; skill: string | null } | undefined {
  const o = objectOf(output);
  if (!o || o.ok !== true || typeof o.id !== "string") return undefined;
  return {
    id: o.id,
    url: typeof o.url === "string" ? o.url : `/c/${o.id}`,
    sandbox: typeof o.sandbox === "string" ? o.sandbox : "",
    skill: typeof o.skill === "string" ? o.skill : null,
  };
}

/** 0037 phase 3: the start_thread card — a background child chat whose
 *  pill follows the thread (polled while its turn is live). */
export function StartThreadCard({
  state,
  input,
  output,
  errorText,
}: {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const started = threadStarted(output);
  const i = objectOf(input);
  const prompt = typeof i?.prompt === "string" ? i.prompt : undefined;
  const skill = started?.skill ?? (typeof i?.skill === "string" ? i.skill : null);
  const live = useChildStatus(started?.id ?? null);
  const failedToStart = state === "error" || Boolean(failureOf(output));
  const sp = live ? childPill(live) : statePill(state, failedToStart);
  const failed = failedToStart || live?.status === "failed";
  return (
    <Card
      icon={GitForkIcon}
      title={state === "running" ? "Starting thread" : "Thread"}
      subtitle={skill ?? (started ? "plain" : "…")}
      extra={
        <>
          {live && <ChildMeta status={live} kind={skill} />}
          {started ? <MetaChip>{started.sandbox === "attached" ? "this sandbox" : started.sandbox === "own" ? "own sandbox" : "no sandbox"}</MetaChip> : null}
        </>
      }
      link={started ? { href: started.url, label: "Open thread" } : undefined}
      {...sp}
      failed={failed}
      errorLines={failureLines(output, errorText) ?? (live?.status === "failed" && live.error ? [live.error] : undefined)}
      defaultOpen={Boolean(prompt)}
    >
      {prompt ? (
        <MessageResponse className="break-words border-l-2 border-border py-2 pl-3 pr-3 text-[13px] leading-relaxed text-muted-foreground">
          {prompt}
        </MessageResponse>
      ) : undefined}
    </Card>
  );
}


const VISIT_TONE: Record<string, { Icon: LucideIcon; className: string }> = {
  completed: { Icon: CircleCheckIcon, className: "text-success" },
  failed: { Icon: CircleXIcon, className: "text-destructive" },
  running: { Icon: Loader2Icon, className: "animate-spin text-info" },
  waiting: { Icon: CircleDotIcon, className: "text-warning" },
  parked: { Icon: CircleDotIcon, className: "text-warning" },
};

function InspectBody({ view }: { view: InspectView }) {
  return (
    <div className="space-y-2.5 px-3 py-2.5 text-[12.5px]">
      {view.prompt && <MessageResponse className="break-words border-l-2 border-border pl-3 text-muted-foreground">{view.prompt}</MessageResponse>}
      {view.error && <p className="font-mono text-[11px] text-destructive">{view.error}</p>}
      {!view.prompt && view.opener && (
        <MessageResponse className="line-clamp-4 break-words border-l-2 border-border pl-3 text-muted-foreground">{view.opener}</MessageResponse>
      )}
      {view.last && (
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">last · {view.last.role}</span>
          <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">{oneLine(view.last.text, 400)}</span>
        </p>
      )}
      {view.visits.length > 0 && (
        <ol className="space-y-1">
          {view.visits.map((v) => {
            const t = VISIT_TONE[v.status] ?? { Icon: CircleDotIcon, className: "text-muted-foreground" };
            return (
              <li key={v.seq} className="flex items-center gap-2">
                <t.Icon className={cn("size-3.5 shrink-0", t.className)} aria-hidden />
                {v.harness && <HarnessMark kind={v.harness} className="size-3.5" />}
                <span className="font-medium">{v.stage}</span>
                <span className="text-muted-foreground">{v.status}</span>
                {v.to && (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                    <ArrowRightIcon className="size-3" aria-hidden />
                    {v.to}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {view.harnessRuns.length > 0 && (
        <ul className="space-y-1">
          {view.harnessRuns.map((h) => (
            <li key={h.harness} className="flex items-center gap-2">
              <HarnessMark kind={h.harness} className="size-3.5" />
              <span className="font-medium">{h.harness}</span>
              <span className="text-muted-foreground">
                {h.status} · {h.toolCalls} tool {h.toolCalls === 1 ? "call" : "calls"}
              </span>
              {h.error && <span className="truncate font-mono text-[11px] text-destructive">{h.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {(view.messages !== undefined || view.sandbox?.startsWith("sbx_")) && (
        <p className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-muted-foreground">
          {view.messages !== undefined && <span>{view.messages} messages</span>}
          {view.sandbox?.startsWith("sbx_") && (
            <Link href={`/sandboxes/${view.sandbox}`} className="underline-offset-2 hover:text-foreground hover:underline">
              {view.sandbox}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

export function InspectCard({
  state,
  input,
  output,
  errorText,
}: {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const view = useMemo(() => inspectOf(output), [output]);
  const id = objectOf(input)?.id;
  const failed = state === "error" || Boolean(failureOf(output));
  const sp = statePill(state, failed);
  const status = view?.status;
  const tone: Tone = failed ? "fail" : state === "running" ? "running" : status === "failed" ? "fail" : status === "running" ? "running" : status === "waiting" || status === "parked" ? "warn" : "ok";
  const href = view ? (view.kind === "chat" ? `/c/${view.id}` : undefined) : undefined;
  const hasBody = view && (view.prompt || view.opener || view.last || view.error || view.visits.length || view.harnessRuns.length || view.messages !== undefined || view.sandbox?.startsWith("sbx_"));
  return (
    <Card
      icon={SearchCodeIcon}
      title="Inspected"
      subtitle={view ? inspectName(view) : typeof id === "string" ? id : "…"}
      link={href ? { href, label: "Open" } : undefined}
      tone={tone}
      pill={failed ? "failed" : state === "running" ? "running" : view ? inspectState(view) : "done"}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      defaultOpen={Boolean(view && view.visits.length > 0 && view.visits.length <= 8)}
    >
      {hasBody ? <InspectBody view={view} /> : undefined}
    </Card>
  );
}

/** sandbox_exec is a bash call in disguise: the terminal card, labelled with where it ran. */
export function HostExecCard({
  state,
  input,
  output,
  errorText,
}: {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const obj = objectOf(output);
  const ok = obj && obj.ok === true && typeof obj.exitCode === "number" ? obj : undefined;
  const host = objectOf(input)?.host;
  const duration = ok && typeof obj?.durationMs === "number" ? `${(obj.durationMs / 1000).toFixed(1)}s` : undefined;
  // 0043 amendment: ran without asking, under the chat's auto-approve toggle.
  const autoApproved = ok?.autoApproved === true;
  return (
    <BashTerminal
      className="my-1"
      state={state === "running" ? "input-available" : state === "error" ? "output-error" : "output-available"}
      input={objectOf(input)}
      output={ok ? { exitCode: ok.exitCode, stdout: ok.stdout, stderr: ok.stderr } : undefined}
      errorText={errorText ?? failureLines(output)?.join("\n")}
      extra={
        typeof host === "string" ? (
          <span className="flex items-center gap-1.5">
            <span
              title={`exec on ${host}`}
              className="rounded-full border border-terminal-border px-2 py-0.5 font-mono text-[10px] text-terminal-muted"
            >
              {host}
              {duration ? ` · ${duration}` : ""}
            </span>
            {autoApproved && (
              <span
                title="Ran without asking — this chat's auto-approve toggle is on"
                className="rounded-full border border-terminal-border px-2 py-0.5 font-mono text-[10px] text-terminal-muted"
              >
                auto-approved
              </span>
            )}
          </span>
        ) : undefined
      }
    />
  );
}

export function SandboxExecCard({
  state,
  input,
  output,
  errorText,
}: {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const exec = execOf(output);
  const target = objectOf(input)?.target;
  return (
    <BashTerminal
      className="my-1"
      state={state === "running" ? "input-available" : state === "error" ? "output-error" : "output-available"}
      input={objectOf(input)}
      output={exec ? { exitCode: exec.exitCode, stdout: exec.stdout, stderr: exec.stderr } : undefined}
      errorText={errorText ?? failureLines(output)?.join("\n")}
      extra={
        exec?.sandboxId || typeof target === "string" ? (
          <Link
            href={exec?.sandboxId ? `/sandboxes/${exec.sandboxId}` : "#"}
            title={exec?.workDir ? `${exec.sandboxId} · ${exec.workDir}` : undefined}
            className="max-w-40 truncate rounded-full border border-terminal-border px-2 py-0.5 font-mono text-[10px] text-terminal-muted transition-colors hover:text-terminal-foreground"
          >
            {exec?.sandboxId ?? String(target)}
          </Link>
        ) : undefined
      }
    />
  );
}

/** A stage's hand-off: one quiet line — where the run goes next, and why. */
export function TransitionCard({
  state,
  input,
  output,
  errorText,
}: {
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const t = transitionOf(input, output);
  const failed = state === "error" || !t.ok;
  const ending = t.to === "end";
  return (
    <div
      className={cn(
        "not-prose my-1 flex items-start gap-2.5 rounded-lg border px-3 py-2 text-card-foreground",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-card",
      )}
    >
      {ending ? (
        <FlagIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <ArrowRightIcon className={cn("mt-0.5 size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px]">
          <span className="text-muted-foreground">{failed ? "Couldn't hand off to" : ending ? "Finished the run" : "Handed off to"}</span>{" "}
          {!ending && <span className="font-mono font-medium">{t.to}</span>}
        </p>
        {t.reason && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t.reason}</p>}
        {failed && (errorText || t.note) && <p className="mt-0.5 font-mono text-[11px] text-destructive">{errorText ?? t.note}</p>}
      </div>
      {state === "running" && <Pill tone="running" label="running" />}
    </div>
  );
}

