"use client";

import { MessageSquare, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

export interface SidebarItem {
  id: string;
  title: string | null;
  updatedAt: number;
}

// Hydration-safe mounted gate (container TZ vs browser TZ make any
// server-rendered time string a mismatch risk).
const emptySubscribe = () => () => {};
function useMounted() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Conversation navigation (0002): New chat plus the store's conversations,
 * most recently updated first. Server-rendered by the layout from sqlite;
 * the active conversation is highlighted from the URL. A conversation
 * started mid-page (URL replaced without a navigation) appears on the
 * next route change — accepted v1 staleness.
 */
export function ConversationSidebar({ items }: { items: readonly SidebarItem[] }) {
  const pathname = usePathname();
  const mounted = useMounted();

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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {items.length === 0 ? (
          <p className="px-2 py-2 text-xs text-sidebar-foreground/60">
            No conversations yet.
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              const href = `/c/${item.id}`;
              const active = pathname === href;
              return (
                <li key={item.id}>
                  <Link
                    href={href}
                    title={item.title ?? item.id}
                    className={
                      "flex items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors " +
                      (active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "hover:bg-sidebar-accent/60")
                    }
                  >
                    <span className="truncate">
                      {item.title ?? (
                        <span className="font-mono text-xs text-sidebar-foreground/60">
                          {item.id}
                        </span>
                      )}
                    </span>
                    {mounted && (
                      <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60">
                        {relativeTime(item.updatedAt)}
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
          <MessageSquare className="size-3" /> {items.length} in store
        </span>
      </div>
    </nav>
  );
}
