"use client";

import { Archive, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "./context";
import { InlineName } from "./inline-name";
import { MoveMenu } from "./move-menu";
import { RowMenuTrigger } from "./row-menu-trigger";
import { relativeTime, type FolderChoice, type SidebarItem } from "./types";

/**
 * One conversation in the folder tree or the Inbox: a draggable link
 * with a hover menu (rename, move, archive, trash). Dragging only ever
 * *offers* targets in the same group (see use-drop-target).
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
  const active = pathname === `/c/${item.id}`;
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
          href={`/c/${item.id}`}
          draggable={false}
          title={item.title ?? item.id}
          className="flex items-baseline justify-between gap-2 px-2 py-1.5"
        >
          <span className="truncate text-sm">
            {item.title ?? (
              <span className="font-mono text-xs text-sidebar-foreground/60">{item.id}</span>
            )}
          </span>
          {showAge && (
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
              rootLabel="Inbox (unfiled)"
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
              onSelect={() => void actions.setTrashed(item.id, true)}
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
