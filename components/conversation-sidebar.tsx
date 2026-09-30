"use client";

import { FolderGit2, MessageSquare, Search, SquarePen, X } from "lucide-react";
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

export interface SidebarGroup {
  project: { id: string; name: string } | null;
  items: SidebarItem[];
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

function ConversationLink({
  row,
  active,
  showAge,
  showSnippet,
}: {
  row: Row;
  active: boolean;
  showAge: boolean;
  showSnippet: boolean;
}) {
  return (
    <Link
      href={`/c/${row.conversationId}`}
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
        {showAge && row.updatedAt !== undefined && (
          <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60">
            {relativeTime(row.updatedAt)}
          </span>
        )}
        {!showAge && showSnippet && row.hits > 0 && (
          <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60">
            {row.hits}
          </span>
        )}
      </span>
      {showSnippet && row.snippet && (
        <span className="mt-0.5 block truncate text-xs text-sidebar-foreground/60">
          {row.snippet}
        </span>
      )}
    </Link>
  );
}

/**
 * Conversation navigation (0002–0004): New chat, search box, and
 * conversations grouped by project — the group header starts a new
 * conversation in that project (/p/[projectId]). Server-rendered by the
 * layout from sqlite; the active conversation is highlighted from the
 * URL. A conversation started mid-page appears on the next route change
 * — accepted staleness.
 */
export function ConversationSidebar({ groups }: { groups: readonly SidebarGroup[] }) {
  const pathname = usePathname();
  const mounted = useMounted();
  const [query, setQuery] = useState("");
  const results = useConversationSearch(query);
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = query.trim().length > 0;

  const recents = useMemo<Row[]>(
    () =>
      groups.flatMap((group) =>
        group.items.map((item) => ({
          conversationId: item.id,
          title: item.title,
          snippet: null,
          updatedAt: item.updatedAt,
          hits: 0,
        })),
      ),
    [groups],
  );
  const total = recents.length;
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
          title="New chat (no project)"
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
        {searching ? (
          rows.length === 0 ? (
            <p className="px-2 py-2 text-xs text-sidebar-foreground/60">
              No matches.
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.conversationId}>
                  <ConversationLink
                    row={row}
                    active={pathname === `/c/${row.conversationId}`}
                    showAge={false}
                    showSnippet
                  />
                </li>
              ))}
            </ul>
          )
        ) : (
          groups.map((group) => (
            <section key={group.project?.id ?? "unbound"} className="mb-3">
              <div className="flex items-center gap-1.5 px-2 py-1">
                {group.project ? (
                  <Link
                    href={`/p/${group.project.id}`}
                    title={`New conversation in ${group.project.name}`}
                    className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase transition-colors hover:text-sidebar-foreground"
                  >
                    <FolderGit2 className="size-3 shrink-0" />
                    <span className="truncate">{group.project.name}</span>
                  </Link>
                ) : (
                  <span className="text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
                    Chats
                  </span>
                )}
              </div>
              {group.items.length === 0 ? (
                <p className="px-2 py-1 text-xs text-sidebar-foreground/40">
                  No conversations yet.
                </p>
              ) : (
                <ul>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <ConversationLink
                        row={{
                          conversationId: item.id,
                          title: item.title,
                          snippet: null,
                          updatedAt: item.updatedAt,
                          hits: 0,
                        }}
                        active={pathname === `/c/${item.id}`}
                        showAge={mounted}
                        showSnippet={false}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))
        )}
      </div>
      <div className="border-t border-sidebar-border px-3 py-2 text-[10px] text-sidebar-foreground/60">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="size-3" />
          {searching ? `${rows.length} match(es)` : `${total} in store`}
        </span>
      </div>
    </nav>
  );
}
