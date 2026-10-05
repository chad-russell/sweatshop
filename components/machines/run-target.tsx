"use client";

import { Check, ChevronsUpDown, FolderGit2, MessageSquare, Workflow } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * 0012: what a fresh composer sends to — a new chat (default) or a
 * machine run usable in this scope (project machines on a project page,
 * workspace-free machines in Chats). Replaces the 0009 run dialog.
 */

export interface MachineOption {
  id: string;
  name: string;
  description: string | null;
}

/** 0018: a pickable chat-in-project target. */
export interface ProjectOption {
  id: string;
  name: string;
}

interface MachineListing extends MachineOption {
  definition: { workspace: "project" | "none" };
}

/** Machines usable here, fetched once per scope. */
export function useScopedMachines(projectId: string | undefined): MachineOption[] | null {
  const [machines, setMachines] = useState<MachineOption[] | null>(null);
  const wanted = projectId ? "project" : "none";
  useEffect(() => {
    let live = true;
    void fetch("/api/machines", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ machines: MachineListing[] }>) : { machines: [] }))
      .then(({ machines: all }) => {
        if (live) {
          setMachines(
            all
              .filter((m) => m.definition.workspace === wanted)
              .map(({ id, name, description }) => ({ id, name, description })),
          );
        }
      })
      .catch(() => live && setMachines([]));
    return () => {
      live = false;
    };
  }, [wanted]);
  return machines;
}

/** Start a run; resolves to its id or throws with the server's message. */
export async function startMachineRun(input: {
  machineId: string;
  prompt: string;
  projectId?: string;
}): Promise<string> {
  const res = await fetch("/api/machine-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => null)) as
    | { run?: { id: string }; error?: string; details?: string[] }
    | null;
  if (!res.ok || !body?.run) {
    throw new Error(body?.details?.join("; ") ?? body?.error ?? `start failed (${res.status})`);
  }
  return body.run.id;
}

export function RunTargetPicker({
  machines,
  selectedId,
  onSelect,
  projectScoped,
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  machines: readonly MachineOption[] | null;
  /** null = chat. */
  selectedId: string | null;
  onSelect: (machineId: string | null) => void;
  projectScoped: boolean;
  /** 0018: chat-in-project targets; omit to hide the project axis
   *  (the plain "Chat" item stands in for no scope). */
  projects?: readonly ProjectOption[] | null;
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string | null) => void;
}) {
  const selected = machines?.find((m) => m.id === selectedId) ?? null;
  const selectedProject =
    projects?.find((p) => p.id === (selectedProjectId ?? null)) ?? null;
  const label = selected ? selected.name : (selectedProject?.name ?? "Chat");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Send to"
          title="Start a chat (optionally in a project) or a machine run"
          className={cn(
            "inline-flex h-8 max-w-48 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            (selected || selectedProject) && "text-foreground",
          )}
        >
          {selected ? (
            <Workflow className="size-3.5 shrink-0" aria-hidden />
          ) : selectedProject ? (
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <MessageSquare className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {projects && onSelectProject ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                onSelectProject(null);
                onSelect(null);
              }}
              className="items-start py-2"
            >
              <Check className={cn("mt-0.5", !selected && !selectedProject ? "opacity-100" : "opacity-0")} aria-hidden />
              <span className="flex flex-col">
                <span>Chat</span>
                <span className="text-xs font-normal text-muted-foreground">A plain conversation, no project</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Chat in a project
            </DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={() => {
                  onSelectProject(p.id);
                  onSelect(null);
                }}
                className="items-start py-2"
              >
                <Check className={cn("mt-0.5", p.id === (selectedProjectId ?? null) ? "opacity-100" : "opacity-0")} aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{p.name}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    Binds the conversation — and its sandbox — to {p.name}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <DropdownMenuItem onSelect={() => onSelect(null)} className="items-start py-2">
            <Check className={cn("mt-0.5", selected ? "opacity-0" : "opacity-100")} aria-hidden />
            <span className="flex flex-col">
              <span>Chat</span>
              <span className="text-xs font-normal text-muted-foreground">A conversation with your agent</span>
            </span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {projectScoped ? "Run a project machine" : "Run a machine"}
        </DropdownMenuLabel>
        {machines === null && <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>}
        {machines?.length === 0 && (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            None yet —{" "}
            <Link href="/machines/new" className="underline">
              create one
            </Link>
          </p>
        )}
        {machines?.map((m) => (
          <DropdownMenuItem key={m.id} onSelect={() => onSelect(m.id)} className="items-start py-2">
            <Check className={cn("mt-0.5", m.id === selectedId ? "opacity-100" : "opacity-0")} aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span>{m.name}</span>
              {m.description && (
                <span className="line-clamp-2 text-xs font-normal text-muted-foreground">{m.description}</span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
