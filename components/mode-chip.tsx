"use client";

import type { UIMessage } from "ai";
import { Check, ChevronsUpDown, Workflow, X } from "lucide-react";
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
import { backgroundChildIds } from "@/lib/chat-ui";
import type { ChildStatus } from "@/lib/child-status";
import type { ModeChromeData } from "@/lib/read-models/mode-chrome";
import { useChildStatus } from "@/lib/use-child-status";
import { cn } from "@/lib/utils";

/**
 * 0055 PR2 — the Mode chip: leftmost in a project chat's composer
 * tools. Owns mode choice end to end (fresh-target-picker's old "Chat
 * with a skill" axis moved here, scoped to ACTIVE modes only — plain
 * thread skills are agent/child-only now).
 *
 * Mounts a `ChildWatcher` per background child the transcript has ever
 * started (lib/chat-ui.ts's `backgroundChildIds`) — reusing
 * `useChildStatus`'s existing poll (settled children stop fetching on
 * their own) rather than inventing a new one, so "N working" and the
 * menu's "Working now" list stay live with no extra wiring.
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

const TRIGGER =
  "inline-flex h-8 pointer-coarse:h-10 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

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

  // ── Live work: every background child this transcript ever started,
  // polled via the existing per-child status hook. ───────────────────
  const childIds = useMemo(() => backgroundChildIds(messages), [messages]);
  const [statuses, setStatuses] = useState<Record<string, ChildStatus | null>>({});
  const onStatusChange = useCallback((id: string, status: ChildStatus | null) => {
    setStatuses((s) => (s[id] === status ? s : { ...s, [id]: status }));
  }, []);
  const working = childIds.map((id) => statuses[id]).filter((s): s is ChildStatus => Boolean(s?.live));

  if (!projectId) return null;
  if (!chrome && modes.length === 0) return null; // nothing to show or pick

  const pendingTitle = pendingModeId ? modes.find((m) => m.id === pendingModeId)?.title : null;
  const pickedTitle = fresh && pickedSkillId ? modes.find((m) => m.id === pickedSkillId)?.title : null;
  const phaseText = chrome?.current?.name ?? null;
  const fullLabel = chrome
    ? phaseText
      ? `${chrome.title} · ${phaseText}`
      : chrome.title
    : pendingTitle
      ? `pending: ${pendingTitle}`
      : (pickedTitle ?? "Normal");
  const narrowLabel = chrome ? (phaseText ?? chrome.title) : (pendingTitle ?? pickedTitle ?? "Normal");

  const select = (id: string) => {
    if (fresh) onPickSkill(id);
    else onPendingMode(id);
  };

  return (
    <>
      {childIds.map((id) => (
        <ChildWatcher key={id} id={id} onChange={onStatusChange} />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Mode"
            title={chrome ? "This chat's sticky mode — lasts the rest of the chat" : "Enter a sticky mode for this chat"}
            className={cn(TRIGGER, chrome && "border-primary/30 bg-primary/10 text-primary", className)}
          >
            <Workflow className="size-3.5 shrink-0" aria-hidden />
            <span className="hidden truncate sm:inline">{fullLabel}</span>
            <span className="truncate sm:hidden">{narrowLabel}</span>
            {working.length > 0 && (
              <span className="hidden shrink-0 font-mono text-xs sm:inline">{working.length} working</span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
          {chrome ? (
            <>
              <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
                <span className="text-xs font-medium text-foreground">{chrome.title}</span>
                <span className="text-xs text-muted-foreground">This mode stays on for the rest of the chat.</span>
              </DropdownMenuLabel>
              {chrome.phases.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {chrome.phases.map((p) => (
                    <DropdownMenuItem key={p.id} disabled className="items-start py-1.5 opacity-100">
                      <Check className={cn("mt-0.5", p.id === chrome.current?.id ? "opacity-100" : "opacity-0")} aria-hidden />
                      <span>{p.name}</span>
                    </DropdownMenuItem>
                  ))}
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
                          {w.phase ? `${w.phase} · ` : ""}
                          {workLabel(w)}
                        </span>
                        <span className="text-xs font-normal text-muted-foreground">{w.status}</span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </>
          ) : (
            <>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
