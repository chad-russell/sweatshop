"use client";

import type { UIMessage } from "ai";
import { Ban, Check, ChevronsUpDown, Circle, CircleDot, Minus, Workflow, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SkillOption } from "@/components/fresh-target-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { liveBackgroundChildIds } from "@/lib/chat-ui";
import type { ChildStatus } from "@/lib/child-status";
import type { ModeChromeData } from "@/lib/read-models/mode-chrome";
import { activeStepHistory, deriveStatus, findStep, skillsUsed, type StatusState } from "@/lib/status";
import { useChildStatus } from "@/lib/use-child-status";
import { cn } from "@/lib/utils";

/**
 * 0055 PR2 / 0059 — the Mode chip: leftmost in a project chat's composer
 * tools. Owns mode choice end to end (fresh-target-picker's old "Chat
 * with a skill" axis moved here, scoped to ACTIVE modes only — plain
 * thread skills are agent/child-only). A bound non-mode skill does not
 * block entering a mode.
 *
 * Mounts a `ChildWatcher` per background child still outstanding
 * (lib/chat-ui.ts's `liveBackgroundChildIds` — excludes anything whose
 * wake already arrived) — reusing `useChildStatus`'s existing poll
 * (settled children stop fetching on their own) rather than inventing a
 * new one, so "N working" and the menu's "Working now" list stay live
 * with no extra wiring.
 *
 * Picking a mode on a fresh chat sets the creating send's skill
 * directly; on an existing chat it queues `pendingModeId`, sent as
 * `mode` on the very next send.
 */

/** The harness kind from a harness call's href (`/h/<kind>/<conv>/<id>`),
 *  or the thread's skill — whichever `ChildStatus` carries. */
function workLabel(status: ChildStatus): string {
  if (status.kind === "harness") return status.href.split("/")[2] ?? "harness";
  return status.where ?? "thread";
}

function ChildWatcher({
  id,
  onChange,
}: {
  id: string;
  onChange: (id: string, status: ChildStatus | null) => void;
}) {
  const status = useChildStatus(id);
  useEffect(() => {
    onChange(id, status);
  }, [id, status, onChange]);
  return null;
}

/** Same box as the model picker and sandbox control (h-8, items-center, text-sm). */
const TRIGGER =
  "inline-flex h-8 pointer-coarse:h-10 max-w-56 items-center gap-1 rounded-lg border border-border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

const STEP_MARK: Record<StatusState, { icon: typeof Check; className: string }> = {
  done: { icon: Check, className: "text-success" },
  active: { icon: CircleDot, className: "text-info" },
  pending: { icon: Circle, className: "text-muted-foreground" },
  skipped: { icon: Minus, className: "text-muted-foreground" },
  blocked: { icon: Ban, className: "text-warning" },
};

export function ModeChip({
  conversationId,
  projectId,
  started,
  fresh,
  busy,
  messages,
  skills,
  pickedSkillId,
  onPickSkill,
  pendingModeId,
  onPendingMode,
  className,
}: {
  conversationId: string | null;
  /** Modes need a project — the chip is hidden without one. */
  projectId: string | null;
  started: boolean;
  fresh: boolean;
  busy: boolean;
  messages: UIMessage[];
  skills: SkillOption[] | null;
  /** Fresh composer: the creating send's skill target (shared with the
   *  removed skill axis of FreshTargetPicker). */
  pickedSkillId: string | null;
  onPickSkill: (id: string | null) => void;
  /** Existing chat: a mode to enter on the NEXT send. */
  pendingModeId: string | null;
  onPendingMode: (id: string | null) => void;
  className?: string;
}) {
  const modes = useMemo(() => (skills ?? []).filter((s) => s.mode), [skills]);

  // ── The conversation's current mode, server-read (parses the skill's
  // CURRENT body — never drifts from what the agent sees). Refetched on
  // the busy → idle edge, same pattern as ContextMeter. ──────────────
  const [chrome, setChrome] = useState<ModeChromeData | null>(null);
  const sawBusy = useRef(false);
  useEffect(() => {
    if (busy) sawBusy.current = true;
  }, [busy]);
  useEffect(() => {
    // Nothing to fetch yet — `chrome` starts null and a conversation
    // never "un-starts", so there is no stale value to clear here.
    if (!started || !conversationId) return;
    let cancel = false;
    const load = () => {
      fetch(`/api/x/mode/${encodeURIComponent(conversationId)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<ModeChromeData | null>) : null))
        .then((data) => {
          if (!cancel) setChrome(data);
        })
        .catch(() => {
          /* the chip keeps showing what it last knew */
        });
    };
    load();
    const timer = sawBusy.current
      ? setTimeout(() => {
          if (!cancel) load();
        }, 1_500)
      : null;
    return () => {
      cancel = true;
      if (timer) clearTimeout(timer);
    };
  }, [started, conversationId, busy]);

  // ── Live work: every background child this transcript ever started
  // that hasn't already woken it (lib/chat-ui.ts's liveBackgroundChildIds
  // drops settled-and-delivered children), polled via the existing
  // per-child status hook. ────────────────────────────────────────────
  const childIds = useMemo(() => liveBackgroundChildIds(messages), [messages]);
  const [statuses, setStatuses] = useState<Record<string, ChildStatus | null>>({});
  const onStatusChange = useCallback((id: string, status: ChildStatus | null) => {
    setStatuses((s) => (s[id] === status ? s : { ...s, [id]: status }));
  }, []);
  const working = childIds.map((id) => statuses[id]).filter((s): s is ChildStatus => Boolean(s?.live));

  const derived = useMemo(() => deriveStatus(messages), [messages]);
  const history = useMemo(() => activeStepHistory(derived.history), [derived]);
  const used = useMemo(() => skillsUsed(messages), [messages]);

  const mode = chrome?.kind === "mode" ? chrome : null;
  const bound = chrome?.kind === "bound" ? chrome : null;

  if (!projectId) return null;
  if (!chrome && modes.length === 0) return null; // nothing to show or pick

  const pendingTitle = pendingModeId ? modes.find((m) => m.id === pendingModeId)?.title : null;
  const pickedTitle = fresh && pickedSkillId ? modes.find((m) => m.id === pickedSkillId)?.title : null;
  const statusStep = derived.current
    ? (findStep(derived.current.steps, "blocked") ?? derived.current.steps.find((step) => step.state === "active") ?? null)
    : null;
  const phaseText = statusStep?.label ?? mode?.current?.name ?? null;
  const fullLabel = mode
    ? phaseText
      ? `${mode.title} · ${phaseText}`
      : mode.title
    : bound
      ? `Skill: ${bound.skillId}`
      : pendingTitle
        ? `pending: ${pendingTitle}`
        : (pickedTitle ?? "Normal");
  // Narrow (<sm): icon + this text only — a pending mode still needs to
  // read as pending, not as if it had already entered.
  const narrowLabel = mode
    ? (phaseText ?? mode.title)
    : bound
      ? "Skill"
      : pendingTitle
        ? `→ ${pendingTitle}`
        : (pickedTitle ?? "Normal");
  const ariaLabel = mode || bound ? fullLabel : pendingTitle ? `pending: ${pendingTitle}` : "Mode";

  const select = (id: string) => {
    if (fresh) onPickSkill(id);
    else onPendingMode(id);
  };

  const stepper = (() => {
    if (derived.current) return derived.current.steps.map((step) => ({ label: step.label, state: step.state }));
    if (!mode || mode.phases.length === 0) return [];
    const currentIndex = mode.phases.findIndex((phase) => phase.id === mode.current?.id);
    return mode.phases.map((phase, index) => ({
      label: phase.name,
      state: (currentIndex < 0 ? "pending" : index < currentIndex ? "done" : index === currentIndex ? "active" : "pending") as StatusState,
    }));
  })();

  return (
    <>
      {childIds.map((id) => (
        <ChildWatcher key={id} id={id} onChange={onStatusChange} />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            title={mode ? "This chat's mode" : bound ? `Using the "${bound.skillId}" skill` : "Enter a mode for this chat"}
            className={cn(TRIGGER, className, mode && "border-primary/30 bg-primary/10 text-primary")}
          >
            <Workflow className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden truncate sm:inline">{fullLabel}</span>
            <span className="truncate sm:hidden">{narrowLabel}</span>
            {derived.stale && derived.current && (
              <span className="hidden shrink-0 font-normal text-muted-foreground sm:inline">stale</span>
            )}
            {working.length > 0 && (
              <span className="hidden shrink-0 font-mono text-xs sm:inline">{working.length} working</span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
            {mode ? (
              <>
                <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
                  <span className="text-xs font-medium text-foreground">{mode.title}</span>
                  {derived.stale && derived.current && (
                    <span className="text-xs text-muted-foreground">Status is stale — the last wake was not followed by update_status.</span>
                  )}
                </DropdownMenuLabel>
                {stepper.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <ul role="list" aria-label="Status" className="flex flex-col px-2 py-1">
                      {stepper.map((step, index) => {
                        const mark = STEP_MARK[step.state];
                        const Icon = mark.icon;
                        return (
                          <li
                            key={`${index}:${step.label}`}
                            role="listitem"
                            aria-current={step.state === "active" ? "step" : undefined}
                            className="flex items-start gap-2 py-1 text-sm"
                          >
                            <Icon className={cn("mt-0.5 size-3.5 shrink-0", mark.className)} aria-hidden />
                            <span className={cn(step.state === "done" || step.state === "skipped" ? "text-muted-foreground" : "text-foreground")}>
                              {step.label}
                              <span className="sr-only"> ({step.state})</span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                {history.length > 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">History: {history.join(" → ")}</p>
                )}
              </>
            ) : (
              <>
                {bound && (
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Using skill: {bound.skillId}
                  </DropdownMenuLabel>
                )}
                {pendingTitle && (
                  <>
                    <DropdownMenuItem onSelect={() => onPendingMode(null)} className="items-start py-2">
                      <X className="mt-0.5 size-3.5" aria-hidden />
                      <span className="flex flex-col">
                        <span>Clear pending mode</span>
                        <span className="text-xs font-normal text-muted-foreground">
                          {pendingTitle} will enter on the next send — clear to stay normal
                        </span>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {modes.length > 0 ? "Enter a mode" : "No modes defined yet"}
                </DropdownMenuLabel>
                {modes.map((m) => (
                  <DropdownMenuItem key={m.id} onSelect={() => select(m.id)} className="items-start py-2">
                    <Check
                      className={cn("mt-0.5", m.id === (fresh ? pickedSkillId : pendingModeId) ? "opacity-100" : "opacity-0")}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-col">
                      <span>{m.title}</span>
                      {m.description && (
                        <span className="line-clamp-2 text-xs font-normal text-muted-foreground">{m.description}</span>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
                {fresh && pickedSkillId && (
                  <DropdownMenuItem onSelect={() => onPickSkill(null)} className="items-start py-2">
                    <X className="mt-0.5 size-3.5" aria-hidden />
                    <span>Stay normal</span>
                  </DropdownMenuItem>
                )}
              </>
            )}
            {used.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Skills used</DropdownMenuLabel>
                <p className="px-2 pb-1 text-xs text-foreground">{used.join(", ")}</p>
              </>
            )}
            {working.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Working now</DropdownMenuLabel>
                {working.map((w) => (
                  <DropdownMenuItem key={w.id} asChild className="items-start py-1.5">
                    <Link href={w.href} className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">
                        {w.statusLabel ? `${w.statusLabel} · ` : w.phase ? `${w.phase} · ` : ""}
                        {workLabel(w)}
                      </span>
                      <span className="text-xs font-normal text-muted-foreground">{w.status}</span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </>
            )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
