"use client";

import { Archive } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Snippet, whereLabel } from "./search-results";
import { useConversationSearch } from "./use-search";

const ALL = { includeArchived: true } as const;

/**
 * ⌘K / Ctrl-K jump-to-conversation palette (0007), available on every
 * page. Same search as the sidebar — title/summary matches first, then
 * message text — with the folder breadcrumb on each result. cmdk's own
 * filtering is off: ranking comes from the server.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const results = useConversationSearch(query, ALL);
  const hits = query.trim() ? (results ?? []) : [];

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
      <div className="flex flex-col" data-slot="palette">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search conversations…"
        />
        <CommandList>
          {query.trim() && hits.length === 0 && <CommandEmpty>No matches.</CommandEmpty>}
          {!query.trim() && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Type to search every conversation.
            </p>
          )}
          {hits.map((hit) => (
            <CommandItem
              key={hit.conversationId}
              value={hit.conversationId}
              onSelect={() => {
                setOpen(false);
                setQuery("");
                router.push(`/c/${hit.conversationId}`);
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
      </div>
    </CommandDialog>
  );
}
