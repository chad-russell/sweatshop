"use client";

import { Archive, ArrowLeft, Box, Inbox, MessageSquare, MonitorPlay, Search, Settings, SquarePen, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandPalette } from "@/components/sidebar/command-palette";
import { SidebarContext } from "@/components/sidebar/context";
import { useNavDrawer } from "@/components/sidebar/nav-drawer";
import { GroupSection } from "@/components/sidebar/group-section";
import { SearchResults } from "@/components/sidebar/search-results";
import { ShelfView } from "@/components/sidebar/shelf-view";
import { NewProjectButton } from "@/components/project/new-project";
import {
  allItems,
  type Drag,
  type Editing,
  type SidebarData,
} from "@/components/sidebar/types";
import { useSidebarActions } from "@/components/sidebar/use-actions";
import { useCollapsedFolders } from "@/components/sidebar/use-collapsed";
import { useConversationSearch } from "@/components/sidebar/use-search";
import { useAttentionSync } from "@/lib/use-attention-sync";
import { useMounted } from "@/lib/use-mounted";

export type { SidebarData, SidebarGroup, SidebarItem } from "@/components/sidebar/types";

type View = "library" | "archive" | "trash";

const FOOTER_BUTTON =
  "inline-flex items-center gap-1 rounded px-1 py-0.5 pointer-coarse:px-2.5 pointer-coarse:py-2 transition-colors hover:text-sidebar-foreground";

/**
 * Conversation navigation (0002–0004, 0007, 0008): New chat, search, the
 * Inbox (what needs your attention), and per group (project, or Chats) a
 * folder tree plus the Unfiled conversations split by age. Archive and Trash are separate views from
 * the footer. Server-rendered by the layout from sqlite; every mutation
 * goes through the organization API and refreshes the layout. A
 * conversation started mid-page triggers a layout refresh from the
 * chat surface once its session is adopted.
 */
export function ConversationSidebar({
  data,
  inbox,
}: {
  data: SidebarData;
  /** 0008: what the Inbox page would show — drives its badge. */
  inbox: { signature: string; unread: number; needsYou: number };
}) {
  const pathname = usePathname();
  const mounted = useMounted();
  const actions = useSidebarActions();
  useAttentionSync(inbox.signature);
  const { collapsed, toggle } = useCollapsedFolders();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [view, setView] = useState<View>("library");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<string | undefined>(undefined);
  // Mobile drawer state lives in NavDrawerProvider (page headers own the
  // trigger); Escape is the explicit close here.
  const { open: mobileOpen, closeDrawer } = useNavDrawer();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeDrawer]);

  const searching = query.trim().length > 0;
  const results = useConversationSearch(query, {
    project: scope,
    includeArchived: true,
  });
  const total = useMemo(() => allItems(data.groups).length, [data.groups]);

  const scopes = useMemo(
    () => [
      { id: undefined as string | undefined, label: "All" },
      ...data.groups.map((g) => ({
        id: g.project?.id ?? "none",
        label: g.project?.name ?? "Chats",
      })),
    ],
    [data.groups],
  );

  const context = {
    actions,
    pathname,
    mounted,
    collapsed,
    toggleFolder: toggle,
    editing,
    setEditing,
    drag,
    setDrag,
  };

  return (
    <SidebarContext.Provider value={context}>
      <nav
        aria-label="Conversations"
        {...(mobileOpen ? { role: "dialog", "aria-modal": "true" } : {})}
        className={cn(
          "h-dvh w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          mobileOpen
            ? "fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] animate-in slide-in-from-left duration-200 shadow-lg md:hidden"
            : "hidden md:flex",
        )}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <span className="px-1 font-mono text-sm">sweatshop</span>
          <span className="flex items-center gap-1">
            <Link
              href="/"
              aria-label="New chat"
              title="New chat (no project)"
              className="inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <SquarePen className="size-4" />
            </Link>
            <ThemeToggle />
            {/* Drawer mode only (the nav is otherwise hidden below md). */}
            <button
              type="button"
              aria-label="Close navigation"
              onClick={closeDrawer}
              className="inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:hidden"
            >
              <X className="size-4" />
            </button>
          </span>
        </div>

        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-sidebar-border px-2 py-1.5 pointer-coarse:py-2.5 focus-within:ring-2 focus-within:ring-sidebar-ring">
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
              className="w-full bg-transparent text-base md:text-sm outline-none placeholder:text-sidebar-foreground/60"
            />
            {searching ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="shrink-0 text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd className="shrink-0 rounded border border-sidebar-border px-1 font-mono text-[10px] text-sidebar-foreground/50">
                ⌘K
              </kbd>
            )}
          </div>
          {searching && scopes.length > 2 && (
            <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Search scope">
              {scopes.map((s) => (
                <button
                  key={s.id ?? "all"}
                  type="button"
                  aria-pressed={scope === s.id}
                  onClick={() => setScope(s.id)}
                  className={cn(
                    "max-w-full truncate rounded-full border px-2 py-0.5 pointer-coarse:px-3 pointer-coarse:py-1.5 text-[11px] transition-colors",
                    scope === s.id
                      ? "border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground"
                      : "border-sidebar-border text-sidebar-foreground/60 hover:text-sidebar-foreground",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-3 pb-2">
          <Link
            href="/inbox"
            aria-current={pathname === "/inbox" ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors hover:bg-sidebar-accent/60",
              pathname === "/inbox" && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Inbox className="size-4 shrink-0 text-sidebar-foreground/60" />
            <span className="flex-1">Inbox</span>
            {inbox.needsYou > 0 && (
              <span
                title={`${inbox.needsYou} waiting on you`}
                className="rounded-full bg-warning px-1.5 font-mono text-[10px] leading-4 font-medium text-background"
              >
                {inbox.needsYou}
              </span>
            )}
            {inbox.unread > 0 && (
              <span
                title={`${inbox.unread} unread`}
                className="rounded-full bg-sidebar-primary px-1.5 font-mono text-[10px] leading-4 font-medium text-sidebar-primary-foreground"
              >
                {inbox.unread}
              </span>
            )}
          </Link>
          <Link
            href="/sandboxes"
            aria-current={pathname.startsWith("/sandboxes") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors hover:bg-sidebar-accent/60",
              pathname.startsWith("/sandboxes") && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Box className="size-4 shrink-0 text-sidebar-foreground/60" />
            <span className="flex-1">Sandboxes</span>
          </Link>
          {/* 0016: long-running servers in sandboxes, and branch previews. */}
          <Link
            href="/previews"
            aria-current={pathname.startsWith("/previews") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors hover:bg-sidebar-accent/60",
              pathname.startsWith("/previews") && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <MonitorPlay className="size-4 shrink-0 text-sidebar-foreground/60" />
            <span className="flex-1">Previews</span>
          </Link>
          {/* 0033 B-UI: the creation half of the createProject core
              (the agent's create_project is the other). */}
          <NewProjectButton />
          {/* 0021: default model routes, provider availability. */}
          <Link
            href="/settings"
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors hover:bg-sidebar-accent/60",
              pathname.startsWith("/settings") && "bg-sidebar-accent text-sidebar-accent-foreground",
            )}
          >
            <Settings className="size-4 shrink-0 text-sidebar-foreground/60" />
            <span className="flex-1">Settings</span>
          </Link>
        </div>

        {actions.error && (
          <div
            role="alert"
            className="mx-3 mb-2 flex items-start justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          >
            <span>{actions.error}</span>
            <button type="button" aria-label="Dismiss" onClick={actions.clearError}>
              <X className="size-3" />
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {searching ? (
            <SearchResults hits={results ?? []} />
          ) : view === "library" ? (
            data.groups.map((group) => (
              <GroupSection key={group.project?.id ?? "unbound"} group={group} />
            ))
          ) : (
            <>
              <button
                type="button"
                onClick={() => setView("library")}
                className="mb-2 inline-flex items-center gap-1 px-2 pointer-coarse:py-2 text-xs text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
              >
                <ArrowLeft className="size-3" />
                Back to conversations
              </button>
              <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
                {view === "archive" ? "Archive" : "Trash"}
              </div>
              <ShelfView
                mode={view === "archive" ? "archive" : "trash"}
                items={view === "archive" ? data.archived : data.trashed}
              />
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-sidebar-border px-3 py-2 text-[10px] text-sidebar-foreground/60">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3" />
            {searching ? `${(results ?? []).length} match(es)` : `${total} in store`}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={view === "archive"}
              onClick={() => setView(view === "archive" ? "library" : "archive")}
              className={cn(FOOTER_BUTTON, view === "archive" && "text-sidebar-foreground")}
            >
              <Archive className="size-3" />
              {data.archived.length}
            </button>
            <button
              type="button"
              aria-pressed={view === "trash"}
              onClick={() => setView(view === "trash" ? "library" : "trash")}
              className={cn(FOOTER_BUTTON, view === "trash" && "text-sidebar-foreground")}
            >
              <Trash2 className="size-3" />
              {data.trashed.length}
            </button>
          </span>
        </div>
      </nav>
      {/* Mobile: backdrop while the drawer is open (the trigger is in
          each page's header — see NavTrigger). */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={closeDrawer}
          className="fixed inset-0 z-40 animate-in fade-in duration-200 bg-foreground/25 backdrop-blur-[2px] md:hidden"
        />
      )}
      <CommandPalette />
    </SidebarContext.Provider>
  );
}
