"use client";

import { Check, ChevronsUpDown, FolderGit2, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The fresh composer's target picker (0012 → 0037 phase 5 → 0055 PR2):
 * what a new chat is — a plain chat, or a chat in a project (0018). The
 * machine-run axis died with machines; the skill axis (0039) moved to
 * the Mode chip (components/mode-chip.tsx) — non-mode thread skills are
 * agent/child-only now, so this picker is project scope only.
 */

/** 0018: a pickable chat-in-project target. */
export interface ProjectOption {
  id: string;
  name: string;
}

/** 0039/0055: a thread skill a project chat can run by. */
export interface SkillOption {
  id: string;
  title: string;
  description: string;
  /** 0055 v7: this skill is a mode (lib/agent/mode-ids.ts). The Mode
   *  chip offers only these; plain thread skills are agent/child-only. */
  mode: boolean;
}

/** The thread-skill catalog, fetched once — consumed by the Mode chip. */
export function useSkills(): SkillOption[] | null {
  const [books, setBooks] = useState<SkillOption[] | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/skills", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ skills: SkillOption[] }>) : { skills: [] }))
      .then(({ skills }) => live && setBooks(skills))
      .catch(() => live && setBooks([]));
    return () => {
      live = false;
    };
  }, []);
  return books;
}

export function FreshTargetPicker({
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  /** 0018: chat-in-project targets; omit to hide the project axis. */
  projects?: readonly ProjectOption[] | null;
  selectedProjectId?: string | null;
  onSelectProject?: (projectId: string | null) => void;
}) {
  const selectedProject = projects?.find((p) => p.id === (selectedProjectId ?? null)) ?? null;
  const label = selectedProject?.name ?? "Chat";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Send to"
          title="Start a chat, optionally in a project"
          className={cn(
            "inline-flex h-8 pointer-coarse:h-10 max-w-48 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            selectedProject && "text-foreground",
          )}
        >
          {selectedProject ? (
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <MessageSquare className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="size-3.5 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1rem)]">
        {projects && onSelectProject ? (
          <>
            <DropdownMenuItem onSelect={() => onSelectProject(null)} className="items-start py-2">
              <Check className={cn("mt-0.5", !selectedProject ? "opacity-100" : "opacity-0")} aria-hidden />
              <span className="flex flex-col">
                <span>Chat</span>
                <span className="text-xs font-normal text-muted-foreground">A plain conversation, no project</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Chat in a project
            </DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => onSelectProject(p.id)} className="items-start py-2">
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
          <DropdownMenuItem className="items-start py-2">
            <span className="flex flex-col">
              <span>Chat</span>
              <span className="text-xs font-normal text-muted-foreground">A conversation with your agent</span>
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
