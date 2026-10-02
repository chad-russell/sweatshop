"use client";

import type { UIMessage } from "ai";
import {
  Archive,
  ArchiveRestore,
  Bot,
  Box,
  CircleCheck,
  CircleDot,
  CircleSlash,
  CircleX,
  ChevronDown,
  ExternalLink,
  Hand,
  Loader2,
  MoreHorizontal,
  PanelRightOpen,
  PauseCircle,
  Pencil,
  Square,
  Terminal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppHeader } from "@/components/app-header";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChatMessageView } from "@/components/chat-session";
import { HarnessLiveLine, HarnessSummary, TaskQuote } from "@/components/harness-card";
import { HarnessMark } from "@/components/harness-logo";
import { HarnessEventLog, type HarnessEvent } from "@/components/harness-session-view";
import { usePageContext } from "@/components/page-context";
import { SandboxStatus } from "@/components/sandbox-status";
import { MoveMenu } from "@/components/sidebar/move-menu";
import type { FolderChoice } from "@/components/sidebar/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MachineStageRun } from "@/db/schema";
import type { RunView as Run } from "@/db/machines";
import type { SandboxLink } from "@/db/sandbox-view";
import { shortSandboxId } from "@/lib/sandbox-id";
import { useMarkSeen } from "@/lib/use-mark-seen";
import { cn } from "@/lib/utils";
import { GateAnswer } from "./gate-answer";
import { overlayFromVisits } from "./machine-graph";
import { LazyMachineGraph } from "./machine-graph-lazy";

const TERMINAL = new Set(["completed", "failed", "cancelled", "needs-attention"]);
const LIVE = new Set(["running", "waiting"]);

const RUN_TONE: Record<string, string> = {
  running: "text-info",
  waiting: "text-warning",
  "needs-attention": "text-warning",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

export interface RunConversation {
  title: string | null;
  folderId: string | null;
  /** Folder breadcrumb within the group. */
  path: string[];
  archived: boolean;
  folderChoices: FolderChoice[];
}

/**
 * Live view of one machine run (0009) — 0012: a conversation-shaped page.
 * The header is the run conversation's breadcrumb with its organize
 * menu and Cancel; the body is the stage timeline with the inline gate;
 * a visit's transcript (agent conversation or harness events) opens in a
 * side panel instead of leaving the run.
 */
export function MachineRunView({
  initialRun,
  initialVisits,
  projectName,
  sandbox,
  conversation,
}: {
  initialRun: Run;
  initialVisits: MachineStageRun[];
  projectName: string | null;
  /** The run's one sandbox, if it has one (project machines). */
  sandbox: SandboxLink | null;
  conversation: RunConversation;
}) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [visits, setVisits] = useState(initialVisits);
  const [panelSeq, setPanelSeq] = useState<number | null>(null);
  const [graphOpen, setGraphOpen] = useState(true);
  const overlay = useMemo(() => overlayFromVisits(visits, run), [visits, run]);

  // 0015: the panel's "this" — the run, its status and current stage
  // (re-registered every render, so a send reads the polled state).
  usePageContext({
    kind: "run",
    id: run.id,
    title: conversation.title ?? run.machineName,
    runStatus: run.status,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(run.currentStage ? { currentStage: run.currentStage } : {}),
  });

  // A graph node opens its latest visit's transcript (or the card, for
  // human gates) and scrolls the timeline to it.
  const focusStage = (stageId: string | null) => {
    if (!stageId) return;
    const latest = [...visits].reverse().find((v) => v.stageId === stageId);
    if (!latest) return;
    document.getElementById(`visit-${latest.seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (visitLink(latest)) setPanelSeq(latest.seq);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening a run marks it seen (0008 semantics, 0012 settle-unread).
  useMarkSeen(run.id, `${run.status}:${visits.length}`);

  useEffect(() => {
    if (TERMINAL.has(run.status)) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/machine-runs/${run.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { run: Run; visits: MachineStageRun[] };
        // Status changes move the sidebar glyph; refresh the layout then.
        if (body.run.status !== run.status) router.refresh();
        setRun(body.run);
        setVisits(body.visits);
      } catch {
        /* transient — keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [run.id, run.status, router]);

  const organize = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/conversations/${run.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `failed (${res.status})`);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!confirm("Cancel this run? Its sandbox is released and it cannot be resumed.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/machine-runs/${run.id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(`cancel failed (${res.status})`);
      const fresh = await fetch(`/api/machine-runs/${run.id}`, { cache: "no-store" });
      if (fresh.ok) {
        const body = (await fresh.json()) as { run: Run; visits: MachineStageRun[] };
        setRun(body.run);
        setVisits(body.visits);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "cancel failed");
    } finally {
      setBusy(false);
    }
  };

  const rename = () => {
    const title = prompt("Rename run", conversation.title ?? "");
    if (title?.trim()) void organize({ title });
  };

  const trash = async () => {
    const live = LIVE.has(run.status);
    if (!confirm(live ? "This run is still going. Cancel it and move it to trash?" : "Move this run to trash?")) return;
    if (await organize({ trashed: true })) router.push(run.projectId ? `/p/${run.projectId}` : "/");
  };

  const groupCrumb = run.projectId
    ? { label: projectName ?? run.projectId, href: `/p/${run.projectId}` }
    : { label: "Chats", href: "/" };
  const panelVisit = panelSeq === null ? null : (visits.find((v) => v.seq === panelSeq) ?? null);

  return (
    <div className="flex h-dvh w-full">
      <div className="mx-auto flex h-dvh min-w-0 max-w-3xl flex-1 flex-col">
        <AppHeader
          crumbs={[
            groupCrumb,
            ...conversation.path.map((name) => ({ label: name })),
            { label: conversation.title ?? run.machineName },
          ]}
        >
          <span className={cn("flex items-center gap-1.5 font-mono text-xs", RUN_TONE[run.status])}>
            {run.status === "running" && <Loader2 className="size-3.5 animate-spin" />}
            {run.status}
          </span>
          {LIVE.has(run.status) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancel()}>
              <Square /> Cancel
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Run actions" disabled={busy}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={rename}>
                <Pencil /> Rename
              </DropdownMenuItem>
              <MoveMenu
                rootLabel="Unfiled"
                currentId={conversation.folderId}
                choices={conversation.folderChoices}
                onPick={(folderId) => void organize({ folderId })}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void organize({ archived: !conversation.archived })}>
                {conversation.archived ? <ArchiveRestore /> : <Archive />}
                {conversation.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void trash()}>
                <X /> Move to trash
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </AppHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-5 p-6">
            <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
              <span>{run.machineName}</span>
              <span>v{run.machineVersion}</span>
              <span>{run.id}</span>
              {!run.projectId && <span>no workspace</span>}
              {sandbox && (
                <Link
                  href={`/sandboxes/${sandbox.id}`}
                  title="Every stage of this run works in this sandbox"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                >
                  <Box className="size-3" aria-hidden />
                  {shortSandboxId(sandbox.id)}
                  <SandboxStatus status={sandbox.status} className="text-[10px]" />
                </Link>
              )}
              {run.machineId && (
                <Link href={`/machines/${run.machineId}`} className="underline-offset-2 hover:underline">
                  edit machine
                </Link>
              )}
            </p>
            {(run.error || error) && (
              <p role="alert" className="rounded-md border border-warning/50 bg-card p-2 text-sm text-warning">
                {error ?? run.error}
              </p>
            )}

            <section className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setGraphOpen((v) => !v)}
                aria-expanded={graphOpen}
                className="flex items-center gap-1 self-start text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
              >
                <ChevronDown className={cn("size-3.5 transition-transform", !graphOpen && "-rotate-90")} aria-hidden />
                Machine
              </button>
              {graphOpen && (
                <div className="h-56 overflow-hidden rounded-lg border border-border">
                  <LazyMachineGraph definition={run.definition} overlay={overlay} onSelectNode={focusStage} compact />
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
              <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Prompt</h2>
              <p className="mt-2 text-sm whitespace-pre-wrap">{run.prompt}</p>
            </section>

            <ol className="flex flex-col gap-3">
              {visits.map((visit) => (
                <StageCard
                  key={visit.seq}
                  run={run}
                  visit={visit}
                  selected={visit.seq === panelSeq}
                  onOpen={() => setPanelSeq(visit.seq === panelSeq ? null : visit.seq)}
                />
              ))}
              {visits.length === 0 && run.status === "running" && (
                <li className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {run.projectId ? "Provisioning the sandbox…" : "Starting…"}
                </li>
              )}
            </ol>
          </div>
        </div>
      </div>

      {panelVisit && (
        <TranscriptPanel
          key={panelVisit.seq}
          run={run}
          visit={panelVisit}
          onClose={() => setPanelSeq(null)}
        />
      )}
    </div>
  );
}

/**
 * A harness stage's body: the stage's instructions as the task quote, a
 * live "what is it doing" line while it runs, then its summary — the same
 * treatment as the chat's pi/claude card. The bands run edge to edge, so
 * they cancel the card's padding.
 */
function HarnessStageBody({
  visit,
  instructions,
}: {
  visit: MachineStageRun;
  instructions: string | undefined;
}) {
  const running = visit.status === "running";
  const summary = visit.outcome?.trim();
  return (
    <>
      {instructions?.trim() && <TaskQuote>{instructions.trim()}</TaskQuote>}
      <HarnessLiveLine
        conversationId={visit.sessionId}
        kind={visit.harness ?? "pi"}
        active={running}
        className="-mx-4"
      />
      {visit.error && (
        <p className="-mx-4 border-t border-destructive/30 bg-destructive/10 px-4 py-2 font-mono text-[11px] text-destructive">
          {visit.error}
        </p>
      )}
      {summary && (
        <div className={cn("-mx-4 px-4", (instructions?.trim() || running) && "border-t border-border pt-3")}>
          <HarnessSummary>{summary}</HarnessSummary>
        </div>
      )}
    </>
  );
}

function visitLink(visit: MachineStageRun): { href: string; label: string } | null {
  if (visit.kind === "harness" && visit.harness && visit.sessionId) {
    return { href: `/h/${visit.harness}/${visit.sessionId}`, label: `${visit.harness} session` };
  }
  if (visit.kind === "agent" && visit.sessionId) return { href: `/c/${visit.sessionId}`, label: "conversation" };
  return null;
}

function StageCard({
  run,
  visit,
  selected,
  onOpen,
}: {
  run: Run;
  visit: MachineStageRun;
  selected: boolean;
  onOpen: () => void;
}) {
  const stage = run.definition.stages[visit.stageId];
  const KindIcon = visit.kind === "harness" ? Terminal : visit.kind === "agent" ? Bot : Hand;
  const waitingGate = visit.kind === "human" && visit.status === "waiting" && run.status === "waiting";
  const hasTranscript = visitLink(visit) !== null;

  return (
    <li
      id={`visit-${visit.seq}`}
      className={cn(
        "flex scroll-mt-4 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground",
        waitingGate && "border-warning/60",
        selected && "border-ring",
      )}
    >
      <header className="flex items-center gap-2">
        <StatusIcon status={visit.status} />
        {visit.kind === "harness" && visit.harness ? (
          <HarnessMark kind={visit.harness} />
        ) : (
          <KindIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{stage?.title ?? visit.stageId}</span>
        <Badge variant="outline" className="font-mono">
          {visit.kind === "harness" ? visit.harness : visit.kind}
        </Badge>
        <span className="ml-auto flex items-center gap-3 font-mono text-xs text-muted-foreground">
          {visit.kind === "harness" && visit.steps > 0 && <span>{visit.steps} steps</span>}
          {visit.transitionTo && <span>→ {visit.transitionTo}</span>}
          {hasTranscript && (
            <button
              type="button"
              onClick={onOpen}
              aria-pressed={selected}
              className="flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
            >
              <PanelRightOpen className="size-3" />
              transcript
            </button>
          )}
        </span>
      </header>
      {visit.kind === "harness" && visit.harness ? (
        <HarnessStageBody visit={visit} instructions={stage?.instructions} />
      ) : (
        <>
          {visit.error && <p className="text-sm text-warning">{visit.error}</p>}
          {visit.outcome && (
            <div className="max-h-96 overflow-auto text-sm">
              {visit.kind === "human" ? (
                <p className="whitespace-pre-wrap text-muted-foreground">“{visit.outcome}”</p>
              ) : (
                <MessageResponse>{visit.outcome}</MessageResponse>
              )}
            </div>
          )}
        </>
      )}
      {waitingGate && stage && (
        <>
          {stage.instructions && <p className="text-sm">{stage.instructions}</p>}
          <GateAnswer runId={run.id} seq={visit.seq} targets={stage.next} />
        </>
      )}
    </li>
  );
}

type Transcript =
  | { kind: "agent"; messages: UIMessage[] }
  | { kind: "harness"; events: HarnessEvent[] };

/** One visit's transcript beside the timeline; polls while the visit runs. */
function TranscriptPanel({
  run,
  visit,
  onClose,
}: {
  run: Run;
  visit: MachineStageRun;
  onClose: () => void;
}) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [failed, setFailed] = useState(false);
  const live = visit.status === "running";
  const link = visitLink(visit);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/machine-runs/${run.id}/visits/${visit.seq}/transcript`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as Transcript;
        if (!stop) setTranscript(body);
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void load();
    if (!live) return () => {
      stop = true;
    };
    const timer = setInterval(() => void load(), 2000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [run.id, visit.seq, live]);

  const title = run.definition.stages[visit.stageId]?.title ?? visit.stageId;
  return (
    <aside className="flex h-dvh w-[min(36rem,45vw)] shrink-0 flex-col border-l border-border bg-background max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:w-[min(36rem,100vw)] max-lg:shadow-lg">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {title} <span className="font-mono text-xs text-muted-foreground">#{visit.seq}</span>
        </span>
        {live && <Loader2 className="size-3.5 animate-spin text-info" aria-label="Running" />}
        {link && (
          <Button asChild size="icon-sm" variant="ghost" title={`Open ${link.label} full page`}>
            <Link href={link.href} aria-label={`Open ${link.label} full page`}>
              <ExternalLink />
            </Link>
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" aria-label="Close transcript" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {failed && !transcript && <p className="text-sm text-muted-foreground">No transcript recorded.</p>}
        {!failed && !transcript && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {transcript?.kind === "harness" && <HarnessEventLog events={transcript.events} />}
        {transcript?.kind === "agent" && (
          <div className="flex flex-col gap-4">
            {transcript.messages.map((message) => (
              <ChatMessageView key={message.id} message={message} conversationId={null} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CircleCheck className="size-4 shrink-0 text-success" />;
    case "failed":
      return <CircleX className="size-4 shrink-0 text-destructive" />;
    case "parked":
      return <PauseCircle className="size-4 shrink-0 text-warning" />;
    case "waiting":
      return <CircleDot className="size-4 shrink-0 text-warning" />;
    case "cancelled":
      return <CircleSlash className="size-4 shrink-0 text-muted-foreground" />;
    default:
      return <Loader2 className="size-4 shrink-0 animate-spin text-info" />;
  }
}
