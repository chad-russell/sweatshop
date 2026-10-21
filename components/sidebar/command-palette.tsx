"use client";

import { Archive, FolderGit2, FolderPlus, MonitorPlay } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { NEW_PROJECT_EVENT } from "@/components/project/new-project";
import { AttentionDot } from "./attention-dot";
import { Snippet, whereLabel } from "./search-results";
import { useConversationSearch } from "./use-search";
import { conversationHref } from "@/lib/conversation-href";
import { allItems, type SidebarData } from "./types";
import { RunGlyph } from "./run-glyph";

const ALL = { includeArchived: true } as const;

interface PalettePreview {
  id: string;
  url: string;
  host: string;
  label: string | null;
  branch: string | null;
  slug: string;
  status: string;
}

/** A running/waiting agent, surfaced so the user can jump straight to it. */
function isRunningItem(item: { activeRunId: string | null; kind: string; runStatus: string | null }): boolean {
  if (item.activeRunId) return true;
  return item.kind === "harness" && (item.runStatus === "running" || item.runStatus === "waiting");
}

/**
 * ⌘K / Ctrl-K jump-to palette (0007), available on every page. Empty
 * query: "Running" (agents working right now) and "Projects" (every
 * project, for a quick jump), then "Open preview", then "Create". A
 * query filters each client-side (title/name substring) and adds
 * conversation search hits from the server — title/summary matches
 * first, then message text — with the folder breadcrumb on each
 * result. cmdk's own filtering is off: ranking comes from here and the
 * server. 0016: "Open preview …" for every preview that is serving
 * (opens its URL in a new tab).
 */
export function CommandPalette({ data }: { data: SidebarData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useConversationSearch(query, ALL);
  const hits = query.trim() ? (results ?? []) : [];
  const [previews, setPreviews] = useState<PalettePreview[]>([]);
  useEffect(() => {
    if (!open) return;
    void fetch("/api/previews", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ previews: PalettePreview[] }>) : { previews: [] }))
      .then(({ previews: all }) => setPreviews(all.filter((p) => p.status === "healthy" || p.status === "starting")))
      .catch(() => setPreviews([]));
  }, [open]);
  const needle = query.trim().toLowerCase();
  const openable = previews.filter(
    (p) => !needle || `open preview ${p.label ?? ""} ${p.branch ?? ""} ${p.slug}`.toLowerCase().includes(needle),
  );

  const projects = useMemo(
    () => data.groups.flatMap((g) => (g.project ? [g.project] : [])),
    [data.groups],
  );
  const matchingProjects = projects.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.id.toLowerCase().includes(needle),
  );

  const projectNameByConversationId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of data.groups) {
      if (!group.project) continue;
      for (const item of allItems([group])) map.set(item.id, group.project.name);
    }
    return map;
  }, [data.groups]);
  const running = useMemo(() => allItems(data.groups).filter(isRunningItem), [data.groups]);
  const matchingRunning = running.filter(
    (r) => !needle || (r.title ?? "").toLowerCase().includes(needle),
  );

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      title="Find a conversation"
      description="Search conversation titles, summaries and messages"
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} data-slot="palette">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search conversations, projects…"
        />
        <CommandList>
          {query.trim() &&
            hits.length === 0 &&
            openable.length === 0 &&
            matchingRunning.length === 0 &&
            matchingProjects.length === 0 &&
            !"new project".includes(needle) && <CommandEmpty>No matches.</CommandEmpty>}
          {!query.trim() && matchingRunning.length === 0 && matchingProjects.length === 0 && (
            <p className="px-3 pt-4 pb-2 text-center text-sm text-muted-foreground">
              Type to search every conversation.
            </p>
          )}
          {matchingRunning.length > 0 && (
            <CommandGroup heading="Running">
              {matchingRunning.map((item) => (
                <CommandItem
                  key={`run:${item.id}`}
                  value={`run:${item.id}`}
                  onSelect={() => {
                    close();
                    router.push(conversationHref(item));
                  }}
                >
                  <RunGlyph status={item.runStatus ?? "running"} />
                  <span className="truncate">{item.title ?? item.id}</span>
                  {item.needsYou && <AttentionDot unread={0} needsYou={1} />}
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {projectNameByConversationId.get(item.id) ?? ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {matchingProjects.length > 0 && (
            <CommandGroup heading="Projects">
              {matchingProjects.map((p) => (
                <CommandItem
                  key={`project:${p.id}`}
                  value={`project:${p.id}`}
                  onSelect={() => {
                    close();
                    router.push(`/p/${encodeURIComponent(p.id)}`);
                  }}
                >
                  <FolderGit2 className="text-muted-foreground" />
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {openable.length > 0 && (
            <CommandGroup heading="Open preview">
              {openable.map((p) => (
                <CommandItem
                  key={`preview:${p.id}`}
                  value={`preview:${p.id}`}
                  onSelect={() => {
                    close();
                    window.open(p.url, "_blank", "noopener,noreferrer");
                  }}
                >
                  <MonitorPlay className="text-muted-foreground" />
                  <span className="truncate">Open preview {p.label ?? p.branch ?? p.slug}</span>
                  <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{p.host}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {/* 0033 B-UI: opens the sidebar's New-project dialog. */}
          {(!needle || "new project".includes(needle)) && (
            <CommandGroup heading="Create">
              <CommandItem
                value="new-project"
                onSelect={() => {
                  close();
                  window.dispatchEvent(new CustomEvent(NEW_PROJECT_EVENT));
                }}
              >
                <FolderPlus className="text-muted-foreground" />
                <span className="truncate">New project</span>
              </CommandItem>
            </CommandGroup>
          )}
          {hits.map((hit) => (
            <CommandItem
              key={hit.conversationId}
              value={hit.conversationId}
              onSelect={() => {
                close();
                router.push(conversationHref({ id: hit.conversationId, kind: hit.kind }));
              }}
              className="flex-col items-start gap-0.5"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="truncate">{hit.title ?? hit.conversationId}</span>
                {hit.archived && <Archive className="size-3 shrink-0 text-muted-foreground" />}
              </span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {whereLabel(hit)}
              </span>
              <span className="w-full truncate text-xs text-muted-foreground">
                <Snippet text={hit.snippet} />
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
