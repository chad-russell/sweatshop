"use client";

import { Archive } from "lucide-react";
import Link from "next/link";
import type { SearchHit } from "@/lib/read-models/search";
import { conversationHref } from "@/lib/conversation-href";
import { useSidebar } from "./context";

/** Render an FTS snippet, turning [match] markers into <mark>. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("[") && part.endsWith("]") ? (
          <mark key={i} className="rounded-sm bg-sidebar-accent px-0.5 text-sidebar-accent-foreground">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** Project/folder breadcrumb, plus a cheap "↳ parent title" hint when the
 *  hit is a start_thread child (0040 phase 2) — search stays a flat
 *  list, but the full conversation map searchConversations already built
 *  made the parent's title free to carry along. */
export function whereLabel(hit: SearchHit): string {
  const breadcrumb = [hit.projectName ?? "Chats", ...hit.path].join(" / ");
  return hit.parentTitle ? `${breadcrumb} · ↳ ${hit.parentTitle}` : breadcrumb;
}

/** Sidebar search results: title, breadcrumb, highlighted snippet. */
export function SearchResults({ hits }: { hits: readonly SearchHit[] }) {
  const { pathname } = useSidebar();

  if (hits.length === 0) {
    return <p className="px-2 py-2 text-xs text-sidebar-foreground/60">No matches.</p>;
  }
  return (
    <ul>
      {hits.map((hit) => (
        <li key={hit.conversationId}>
          <Link
            href={conversationHref({ id: hit.conversationId, kind: hit.kind })}
            title={hit.title ?? hit.conversationId}
            className={
              "block rounded-md px-2 py-1.5 pointer-coarse:py-2.5 transition-colors " +
              (pathname === conversationHref({ id: hit.conversationId, kind: hit.kind })
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60")
            }
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm">{hit.title ?? hit.conversationId}</span>
              {hit.archived && (
                <Archive aria-label="Archived" className="size-3 shrink-0 text-sidebar-foreground/60" />
              )}
            </span>
            <span className="block truncate text-[11px] text-sidebar-foreground/50">
              {whereLabel(hit)}
            </span>
            <span className="mt-0.5 block truncate text-xs text-sidebar-foreground/60">
              <Snippet text={hit.snippet} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
