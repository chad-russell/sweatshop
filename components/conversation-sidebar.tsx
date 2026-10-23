"use client";

import { Archive, ArrowLeft, Box, Ellipsis, FolderGit2, GitPullRequest, Inbox, MonitorPlay, PanelLeftClose, Search, Settings, Trash2, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { SweatshopLogo } from "@/components/sweatshop-logo";
import { CommandPalette } from "@/components/sidebar/command-palette";
import { SidebarContext } from "@/components/sidebar/context";
import { useNavDrawer } from "@/components/sidebar/nav-drawer";
import { GroupSection } from "@/components/sidebar/group-section";
import { SearchResults } from "@/components/sidebar/search-results";
import { NavRow } from "@/components/sidebar/nav-row";
import { ShelfView } from "@/components/sidebar/shelf-view";
import { SidebarResizer } from "@/components/sidebar/sidebar-resizer";
import {
  type Drag,
  type Editing,
  type SidebarData,
} from "@/components/sidebar/types";
import { useSidebarActions } from "@/components/sidebar/use-actions";
import { useCollapsedFolders } from "@/components/sidebar/use-collapsed";
import { useSidebarCollapsed } from "@/components/sidebar/use-sidebar-collapsed";
import { useThreadExpanded } from "@/components/sidebar/use-thread-expanded";
import { useConversationSearch } from "@/components/sidebar/use-search";
import { activeNavPage } from "@/lib/sidebar-nav";
import { useAttentionSync } from "@/lib/use-attention-sync";
import { useMounted } from "@/lib/use-mounted";

export type { SidebarData, SidebarGroup, SidebarItem } from "@/components/sidebar/types";

type View = "library" | "archive" | "trash";

/**
 * Conversation navigation (0002–0004, 0007, 0008, 0040): search, the
 * PAGES (Inbox, Projects, then
 * Sandboxes and Previews — flat rows), and per group (project, or Chats)
 * a folder tree plus the Unfiled conversations split by age. Archive and
 * Trash are views behind the Conversations label's menu; the footer is
 * Settings and the theme button. Server-rendered by the layout from sqlite; every mutation
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
  const { collapsed: sidebarCollapsed, setCollapsed: setSidebarCollapsed } = useSidebarCollapsed();
  const { explicit: threadExpanded, setExpanded: setThreadExpanded } = useThreadExpanded();
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
  const page = activeNavPage(pathname);
  // Collapsed is a md+-only concept (below md the nav is always a
  // drawer); below md this stays false regardless of the stored value.
  const sidebarHiddenMd = sidebarCollapsed && !mobileOpen;

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
    threadExpanded,
    setThreadExpanded,
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
        inert={sidebarHiddenMd || undefined}
        className={cn(
          "relative h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          mobileOpen
            ? "fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] animate-in slide-in-from-left duration-200 shadow-lg md:hidden"
            : sidebarCollapsed
              ? "hidden md:flex md:w-0 md:overflow-hidden md:border-0"
              : "hidden w-(--sidebar-w) md:flex",
        )}
      >
        <div className="flex items-center justify-between px-3 py-3">
          <span className="flex items-center gap-2 px-1 font-mono text-sm">
            <SweatshopLogo className="text-sidebar-primary" />
            sweatshop
          </span>
          <div className="flex items-center gap-1">
            {/* md+ only — collapses the sidebar off-screen; NavTrigger
                reappears in the page header to bring it back. */}
            <button
              type="button"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              onClick={() => setSidebarCollapsed(true)}
              className="hidden size-8 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:inline-flex"
            >
              <PanelLeftClose className="size-4" />
            </button>
            {/* Drawer mode only (the nav is otherwise hidden below md). */}
            <button
              type="button"
              aria-label="Close navigation"
              onClick={closeDrawer}
              className="inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:hidden"
            >
              <X className="size-4" />
            </button>
          </div>
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

        {/* 0040: PAGES — flat rows that fill when active. Daily work, a
            hairline, then infrastructure. */}
        <div className="flex flex-col gap-0.5 px-3 pb-2">
          <NavRow href="/inbox" icon={Inbox} label="Inbox" active={page === "inbox"}>
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
          </NavRow>
          {/* 0053: every PR by his accounts, one page — no badge (a badge
              needs a background poll; the page itself is the check). */}
          <NavRow href="/prs" icon={GitPullRequest} label="PRs" active={page === "prs"} />
          <NavRow href="/projects" icon={FolderGit2} label="Projects" active={page === "projects"} />
          <div role="separator" className="mx-1 my-1.5 h-px bg-sidebar-border" />
          <NavRow href="/sandboxes" icon={Box} label="Sandboxes" active={page === "sandboxes"} />
          {/* 0016: long-running servers in sandboxes, and branch previews. */}
          <NavRow href="/previews" icon={MonitorPlay} label="Previews" active={page === "previews"} />
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

        <div className="flex items-center justify-between px-4 pt-2 pb-1">
          <span className="text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
            {searching
              ? `${(results ?? []).length} match${(results ?? []).length === 1 ? "" : "es"}`
              : view === "library"
                ? "Conversations"
                : view === "archive"
                  ? "Archive"
                  : "Trash"}
          </span>
          {/* 0040: Archive and Trash are views of conversations, so they
              hang off this label rather than the footer. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Conversation views"
                className="inline-flex size-6 pointer-coarse:size-9 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent"
              >
                <Ellipsis className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onSelect={() => setView(view === "archive" ? "library" : "archive")}>
                <Archive />
                Archive
                <span className="ml-auto font-mono text-xs text-muted-foreground">{data.archived.length}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setView(view === "trash" ? "library" : "trash")}>
                <Trash2 />
                Trash
                <span className="ml-auto font-mono text-xs text-muted-foreground">{data.trashed.length}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
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
              <ShelfView
                mode={view === "archive" ? "archive" : "trash"}
                items={view === "archive" ? data.archived : data.trashed}
              />
            </>
          )}
        </div>

        {/* 0040: app-level only — Settings and the theme cycler. */}
        <div className="flex items-center gap-1 border-t border-sidebar-border px-3 py-2">
          <NavRow
            href="/settings"
            icon={Settings}
            label="Settings"
            active={page === "settings"}
            className="flex-1"
          />
          <ThemeToggle />
        </div>
        {/* Resize handle — desktop only; the mobile drawer keeps its own
            fixed width, and there's nothing to drag while collapsed. */}
        {!mobileOpen && !sidebarCollapsed && <SidebarResizer />}
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
      <CommandPalette data={data} />
    </SidebarContext.Provider>
  );
}
