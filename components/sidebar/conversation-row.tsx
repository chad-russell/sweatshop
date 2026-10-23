"use client";

import { Archive, ChevronRight, Loader2, Pencil, Trash2 } from "lucide-react";
import { conversationHref } from "@/lib/conversation-href";
import { defaultExpanded, hasActiveDescendant } from "@/lib/sidebar-tree";
import { ChildGlyph } from "./child-glyph";
import { isLiveRun } from "./run-glyph";
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
import { relativeTime, type FolderChoice, type SidebarTreeItem } from "./types";
import { useMounted } from "@/lib/use-mounted";

/** Pixels of left padding per nesting level (matches the folder tree). */
const INDENT = 12;

/**
 * One conversation in the folder tree or the Unfiled list: a draggable link
 * with a hover menu (rename, move, archive, trash). Dragging only ever
 * *offers* targets in the same group (see use-drop-target). 0048: run rows
 * are retired; a live harness row still carries a status glyph and asks
 * before trashing (RunGlyph/isLiveRun).
 *
 * 0040 phase 2: a `start_thread` child nests under its parent — SAME
 * component, recursive, like FolderNodeView. A parent with children gets
 * a chevron (default open state from lib/sidebar-tree's defaultExpanded:
 * open while a descendant is live or needs Chad, else closed; an explicit
 * click wins from then on — components/sidebar/use-thread-expanded.ts);
 * viewing a descendant always forces its ancestors open so the active row
 * stays visible, independent of that stored choice. Collapsed, the row
 * shows a rolled-up dot/spinner for whatever is hidden below.
 *
 * 0046: a synthetic harness row (kind "harness") carries its own status
 * glyph and link via conversationHref, but is LOCKED to its
 * conversation: no row menu and not draggable, since organizing a
 * session individually would break group locking. It never has children.
 */
export function ConversationRow({
  item,
  projectId,
  folderId,
  depth,
  choices,
  showAge,
}: {
  item: SidebarTreeItem;
  projectId: string | null;
  folderId: string | null;
  depth: number;
  choices: readonly FolderChoice[];
  showAge: boolean;
}) {
  const { actions, pathname, editing, setEditing, setDrag, threadExpanded, setThreadExpanded } = useSidebar();
  // relativeTime is clock- and timezone-dependent — client-only after mount.
  const mounted = useMounted();
  const href = conversationHref(item);
  const active = pathname === href;
  const renaming = editing?.kind === "rename-conversation" && editing.id === item.id;
  // 0046: a harness session is locked to its conversation.
  const locked = item.kind === "harness";

  const hasChildren = item.children.length > 0;
  const forcedOpen = hasChildren && hasActiveDescendant(item, pathname, conversationHref);
  const chosen = threadExpanded.get(item.id);
  const open = hasChildren && (forcedOpen || (chosen ?? defaultExpanded(item)));
  const collapsedAttention = !open && (item.descendantAttention.unread > 0 || item.descendantAttention.needsYou > 0);

  return (
    <div>
      <div
        draggable={!renaming && !locked}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", item.id);
          e.dataTransfer.effectAllowed = "move";
          setDrag({ kind: "conversation", id: item.id, projectId, folderId });
        }}
        onDragEnd={() => setDrag(null)}
        className={cn(
          "group/row relative flex items-center rounded-md transition-colors",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
        )}
        style={{ paddingLeft: depth * INDENT }}
      >
        {hasChildren && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${item.title ?? item.id} and its threads`}
            onClick={() => setThreadExpanded(item.id, !open)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 pointer-coarse:size-9"
          >
            <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          </button>
        )}
        <div className="min-w-0 flex-1">
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
              title={item.step ? `${item.title ?? item.id}\nStep: ${item.step}` : (item.title ?? item.id)}
              className={cn(
                "flex items-center justify-between gap-2 py-1.5 pointer-coarse:py-2.5",
                hasChildren ? "pr-2" : "px-2",
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
                  className={hasChildren ? undefined : "-ml-1"}
                />
                <ChildGlyph item={item} />
                <span className="min-w-0 truncate">
                  {item.title ?? (
                    <span className="font-mono text-xs text-sidebar-foreground/60">{item.id}</span>
                  )}
                </span>
                {collapsedAttention && (
                  <AttentionDot unread={item.descendantAttention.unread} needsYou={item.descendantAttention.needsYou} />
                )}
                {!open && item.anyDescendantRunning && (
                  <Loader2 aria-label="A thread is running" className="size-3 shrink-0 animate-spin text-info" />
                )}
              </span>
              {showAge && mounted && (
                <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60 group-focus-within/row:invisible group-hover/row:invisible group-has-[[data-state=open]]/row:invisible pointer-coarse:invisible">
                  {relativeTime(item.updatedAt)}
                </span>
              )}
            </Link>
          )}
        </div>
        {!renaming && !locked && (
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
      {open && (
        // The guide line is DOM-nesting-driven, not depth-multiplied: each
        // level's wrapper contributes one fixed indent (ml-3 to step right,
        // pl-3 + border-l to draw the line beside it), and a grandchild's
        // own wrapper nests inside this one — so depth resets to 1 here
        // rather than accumulating depth+1 (that would double-count this
        // wrapper's own offset on top of the child row's own padding).
        <div className="ml-3 border-l border-sidebar-border/60 pl-3">
          {item.children.map((child) => (
            <ConversationRow
              key={child.id}
              item={child}
              projectId={projectId}
              folderId={folderId}
              depth={1}
              choices={choices}
              showAge={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
