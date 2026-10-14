"use client";

import { Archive, Pencil, Trash2 } from "lucide-react";
import { conversationHref } from "@/lib/conversation-href";
import { RunGlyph, isLiveRun } from "./run-glyph";
import Link from "next/link";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { AttentionDot } from "./attention-dot";
import { useSidebar } from "./context";
import { InlineName } from "./inline-name";
import { MoveMenu } from "./move-menu";
import { RowMenuTrigger } from "./row-menu-trigger";
import { relativeTime, type FolderChoice, type SidebarItem } from "./types";
import { useMounted } from "@/lib/use-mounted";

/**
 * One conversation in the folder tree or the Unfiled list: a draggable link
 * with a hover menu (rename, move, archive, trash). Dragging only ever
 * *offers* targets in the same group (see use-drop-target). 0012: a run
 * row carries a status glyph and opens the run view; trashing a live run
 * cancels it, so that asks first.
 */
export function ConversationRow({
  item,
  projectId,
  folderId,
  depth,
  choices,
  showAge,
}: {
  item: SidebarItem;
  projectId: string | null;
  folderId: string | null;
  depth: number;
  choices: readonly FolderChoice[];
  showAge: boolean;
}) {
  const { actions, pathname, editing, setEditing, setDrag } = useSidebar();
  // relativeTime is clock- and timezone-dependent — client-only after mount.
  const mounted = useMounted();
  const href = conversationHref(item);
  const active = pathname === href;
  const renaming = editing?.kind === "rename-conversation" && editing.id === item.id;

  return (
    <div
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", item.id);
        e.dataTransfer.effectAllowed = "move";
        setDrag({ kind: "conversation", id: item.id, projectId, folderId });
      }}
      onDragEnd={() => setDrag(null)}
      className={cn(
        "group/row relative rounded-md transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
      )}
      style={{ paddingLeft: depth * 12 }}
    >
      {renaming ? (
        <div className="flex px-2 py-1">
          <InlineName
            label="Conversation title"
            initial={item.title ?? ""}
            onCancel={() => setEditing(null)}
            onSubmit={(title) => {
              setEditing(null);
              void actions.renameConversation(item.id, title);
            }}
          />
        </div>
      ) : (
        <Link
          href={href}
          draggable={false}
          title={item.title ?? item.id}
          className={cn(
            "flex items-center justify-between gap-2 px-2 py-1.5 pointer-coarse:py-2.5",
            // Rows with an age already clear the "⋮" button (the age hides on hover but keeps
            // its room). Rows without one reserve the button's room while it shows, so a
            // truncated title's "…" stops short of it instead of running into it.
            !showAge &&
              "group-focus-within/row:pr-9 group-hover/row:pr-9 group-has-[[data-state=open]]/row:pr-9 pointer-coarse:pr-11",
          )}
        >
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 text-sm",
              item.unread && !item.needsYou && "font-medium",
            )}
          >
            <AttentionDot
              unread={item.unread ? 1 : 0}
              needsYou={item.needsYou ? 1 : 0}
              className="-ml-1"
            />
            {item.kind === "run" && <RunGlyph status={item.runStatus} />}
            <span className="truncate">
              {item.title ?? (
                <span className="font-mono text-xs text-sidebar-foreground/60">{item.id}</span>
              )}
            </span>
          </span>
          {showAge && mounted && (
            <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60 group-focus-within/row:invisible group-hover/row:invisible group-has-[[data-state=open]]/row:invisible pointer-coarse:invisible">
              {relativeTime(item.updatedAt)}
            </span>
          )}
        </Link>
      )}
      {!renaming && (
        <DropdownMenu>
          <RowMenuTrigger label={`Actions for ${item.title ?? item.id}`} />
          <DropdownMenuContent
            align="start"
            className="w-48"
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <DropdownMenuItem onSelect={() => setEditing({ kind: "rename-conversation", id: item.id })}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <MoveMenu
              rootLabel="Unfiled"
              currentId={folderId}
              choices={choices}
              onPick={(id) => void actions.moveConversation(item.id, id)}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void actions.setArchived(item.id, true)}>
              <Archive />
              Archive
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                if (
                  isLiveRun(item) &&
                  !confirm(`"${item.title ?? item.id}" is still running. Cancel the run and move it to trash?`)
                ) {
                  return;
                }
                void actions.setTrashed(item.id, true);
              }}
            >
              <Trash2 />
              Move to trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
