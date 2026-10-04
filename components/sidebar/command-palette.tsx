"use client";

import { Archive, MonitorPlay, Workflow } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Snippet, whereLabel } from "./search-results";
import { useConversationSearch } from "./use-search";
import { conversationHref } from "@/lib/conversation-href";

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

interface PaletteMachine {
  id: string;
  name: string;
  definition: { workspace: "project" | "none" };
}

/**
 * ⌘K / Ctrl-K jump-to-conversation palette (0007), available on every
 * page. Same search as the sidebar — title/summary matches first, then
 * message text — with the folder breadcrumb on each result. cmdk's own
 * filtering is off: ranking comes from the server. 0012: "Run <machine>"
 * commands open a fresh composer with that machine preselected (in the
 * current project for project machines). 0016: "Open preview …" for
 * every preview that is serving (opens its URL in a new tab).
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useConversationSearch(query, ALL);
  const hits = query.trim() ? (results ?? []) : [];
  const pathname = usePathname();
  const projectId = /^\/p\/([^/]+)/.exec(pathname)?.[1] ?? null;
  const [machines, setMachines] = useState<PaletteMachine[]>([]);
  useEffect(() => {
    if (!open) return;
    void fetch("/api/machines", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ machines: PaletteMachine[] }>) : { machines: [] }))
      .then(({ machines: all }) => setMachines(all))
      .catch(() => setMachines([]));
  }, [open]);
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
  // Project machines need a project: offered only on a project page.
  const runnable = machines.filter(
    (m) =>
      (m.definition.workspace === "none" || projectId) &&
      (!needle || `run ${m.name}`.toLowerCase().includes(needle)),
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
          placeholder="Search conversations…"
        />
        <CommandList>
          {query.trim() && hits.length === 0 && runnable.length === 0 && openable.length === 0 && (
            <CommandEmpty>No matches.</CommandEmpty>
          )}
          {!query.trim() && (
            <p className="px-3 pt-4 pb-2 text-center text-sm text-muted-foreground">
              Type to search every conversation.
            </p>
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
          {runnable.length > 0 && (
            <CommandGroup heading="Run machine">
              {runnable.map((m) => (
                <CommandItem
                  key={`run:${m.id}`}
                  value={`run:${m.id}`}
                  onSelect={() => {
                    close();
                    const scope = m.definition.workspace === "project" ? `/p/${projectId}` : "/";
                    router.push(`${scope}?machine=${encodeURIComponent(m.id)}`);
                  }}
                >
                  <Workflow className="text-muted-foreground" />
                  <span className="truncate">Run {m.name}</span>
                </CommandItem>
              ))}
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
