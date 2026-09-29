"use client";

import { MessageSquare, Search, SquarePen, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchHit } from "@/db/search";
import { useMounted } from "@/lib/use-mounted";

export interface SidebarItem {
  id: string;
  title: string | null;
  updatedAt: number;
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString();
}

/** Debounced search over the store (0003); empty query means "recents". */
function useConversationSearch(query: string): SearchHit[] | null {
  const [results, setResults] = useState<SearchHit[] | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (res.ok) return (await res.json()) as { results: SearchHit[] };
          return { results: [] };
        })
        .then((body) => setResults(body.results))
        .catch(() => {
          /* aborted or offline — keep the last results */
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  return results;
}

interface Row {
  conversationId: string;
  title: string | null;
  snippet: string | null;
  updatedAt?: number;
  hits: number;
}

/**
 * Conversation navigation (0002/0003): New chat, search box, and the
 * store's conversations (most recently updated first). Server-rendered
 * by the layout from sqlite; the active conversation is highlighted from
 * the URL. A conversation started mid-page (URL replaced without a
 * navigation) appears on the next route change — accepted staleness.
 */
export function ConversationSidebar({ items }: { items: readonly SidebarItem[] }) {
  const pathname = usePathname();
  const mounted = useMounted();
  const [query, setQuery] = useState("");
  const results = useConversationSearch(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  const recents = useMemo<Row[]>(
    () =>
      items.map((item) => ({
        conversationId: item.id,
        title: item.title,
        snippet: null,
        updatedAt: item.updatedAt,
        hits: 0,
      })),
    [items],
  );
  const rows: readonly Row[] = searching ? (results ?? []) : recents;

  return (
    <nav
      aria-label="Conversations"
      className="hidden h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
    >
      <div className="flex items-center justify-between px-3 py-3">
        <span className="px-1 font-mono text-sm">sweatshop</span>
        <Link
          href="/"
          aria-label="New chat"
          title="New chat"
          className="inline-flex size-8 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <SquarePen className="size-4" />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-md border border-sidebar-border px-2 py-1.5 focus-within:ring-2 focus-within:ring-sidebar-ring">
          <Search className="size-3.5 shrink-0 text-sidebar-foreground/60" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                searchRef.current?.blur();
              }
            }}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="w-full bg-transparent text-sm outline-none placeholder:text-sidebar-foreground/60"
          />
          {searching && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="shrink-0 text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-xs text-sidebar-foreground/60">
            {searching
              ? "No matches."
              : "No conversations yet."}
          </p>
        ) : (
          <ul>
            {rows.map((row) => {
              const href = `/c/${row.conversationId}`;
              const active = pathname === href;
              return (
                <li key={row.conversationId}>
                  <Link
                    href={href}
                    title={row.title ?? row.conversationId}
                    className={
                      "block rounded-md px-2 py-1.5 transition-colors " +
                      (active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "hover:bg-sidebar-accent/60")
                    }
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm">
                        {row.title ?? (
                          <span className="font-mono text-xs text-sidebar-foreground/60">
                            {row.conversationId}
                          </span>
                        )}
                      </span>
                      {mounted && !searching && row.updatedAt !== undefined && (
                        <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60">
                          {relativeTime(row.updatedAt)}
                        </span>
                      )}
                      {searching && row.hits > 0 && (
                        <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60">
                          {row.hits}
                        </span>
                      )}
                    </span>
                    {searching && row.snippet && (
                      <span className="mt-0.5 block truncate text-xs text-sidebar-foreground/60">
                        {row.snippet}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t border-sidebar-border px-3 py-2 text-[10px] text-sidebar-foreground/60">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="size-3" />
          {searching ? `${rows.length} match(es)` : `${items.length} in store`}
        </span>
      </div>
    </nav>
  );
}
