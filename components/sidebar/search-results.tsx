"use client";

import { Archive } from "lucide-react";
import Link from "next/link";
import type { SearchHit } from "@/db/search";
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

export function whereLabel(hit: SearchHit): string {
  return [hit.projectName ?? "Chats", ...hit.path].join(" / ");
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
