"use client";

import { ArchiveRestore, Trash2, Undo2 } from "lucide-react";
import Link from "next/link";
import { useSidebar } from "./context";
import { relativeTime, type ShelvedItem } from "./types";
import { conversationHref } from "@/lib/conversation-href";
import { useMounted } from "@/lib/use-mounted";

function Crumbs({ item }: { item: ShelvedItem }) {
  const where = [item.projectName ?? "Chats", ...item.path].join(" / ");
  return <span className="block truncate text-xs text-sidebar-foreground/60">{where}</span>;
}

function IconButton({
  label,
  onClick,
  children,
  destructive,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={
        "inline-flex size-6 pointer-coarse:size-9 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent " +
        (destructive ? "hover:text-destructive" : "hover:text-sidebar-accent-foreground")
      }
    >
      {children}
    </button>
  );
}

/**
 * The Archive and Trash lists. Archive: restore (back to its folder) or
 * trash. Trash: restore or delete forever; the store purges anything
 * older than 30 days on its own.
 */
export function ShelfView({
  mode,
  items,
}: {
  mode: "archive" | "trash";
  items: readonly ShelvedItem[];
}) {
  const { actions, pathname } = useSidebar();
  // relativeTime is clock- and timezone-dependent — client-only after mount.
  const mounted = useMounted();

  if (items.length === 0) {
    return (
      <p className="px-2 py-2 text-xs text-sidebar-foreground/60">
        {mode === "archive" ? "Nothing archived." : "Trash is empty."}
      </p>
    );
  }

  return (
    <>
      {mode === "trash" && (
        <p className="px-2 pb-1 text-[11px] text-sidebar-foreground/50">
          Items are deleted forever after 30 days.
        </p>
      )}
      <ul>
        {items.map((item) => (
          <li
            key={item.id}
            className={
              "group/row flex items-center gap-1 rounded-md px-2 py-1.5 " +
              (pathname === conversationHref(item)
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60")
            }
          >
            <Link href={conversationHref(item)} title={item.title ?? item.id} className="min-w-0 flex-1">
              <span className="block truncate text-sm">{item.title ?? item.id}</span>
              <Crumbs item={item} />
            </Link>
            {mounted && (
              <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60 group-hover/row:hidden">
                {relativeTime(item.at)}
              </span>
            )}
            <span className="hidden shrink-0 items-center group-hover/row:flex">
              <IconButton
                label="Restore"
                onClick={() =>
                  void (mode === "archive"
                    ? actions.setArchived(item.id, false)
                    : actions.setTrashed(item.id, false))
                }
              >
                {mode === "archive" ? (
                  <ArchiveRestore className="size-3.5" />
                ) : (
                  <Undo2 className="size-3.5" />
                )}
              </IconButton>
              <IconButton
                label={mode === "archive" ? "Move to trash" : "Delete forever"}
                destructive
                onClick={() => {
                  if (mode === "archive") void actions.setTrashed(item.id, true);
                  else if (window.confirm("Delete this conversation forever?")) {
                    void actions.deleteForever(item.id);
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
