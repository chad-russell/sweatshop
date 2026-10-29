"use client";

import { conversationLabel } from "@/lib/conversation-label";
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
import { CHEVRON_SLOT, HANDLE_SLOT, guideLeft, rowInset } from "./indent";
import { MoveMenu } from "./move-menu";
import { RowMenuTrigger } from "./row-menu-trigger";
import { relativeTime, type FolderChoice, type SidebarTreeItem } from "./types";
import { useMounted } from "@/lib/use-mounted";
import type { SidebarLocation } from "@/lib/sidebar-organization";

export interface RowLocation extends SidebarLocation {
  choices: readonly FolderChoice[];
}

/**
 * One conversation in a group's list (after its folders) or a folder: a draggable link
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
  projectId: fallbackProjectId,
  folderId: fallbackFolderId,
  depth,
  choices: fallbackChoices,
  showAge,
  locations,
  showContext = false,
  activityAt,
}: {
  item: SidebarTreeItem;
  projectId: string | null;
  folderId: string | null;
  depth: number;
  choices: readonly FolderChoice[];
  showAge: boolean;
  locations?: ReadonlyMap<string, RowLocation>;
  showContext?: boolean;
  activityAt?: number;
}) {
  const location = locations?.get(item.id);
  const projectId = location ? location.projectId : fallbackProjectId;
  const folderId = location ? location.folderId : fallbackFolderId;
  const choices = location ? location.choices : fallbackChoices;
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
          "group/row relative flex items-center gap-1.5 rounded-md transition-colors",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
        )}
        style={{ paddingLeft: rowInset(depth) }}
      >
        {/* 0089: same grid as a folder row — handle slot (conversations
            have no handle), then the chevron slot. A leaf's attention dot
            sits in the chevron slot so the title always starts at the
            icon column. The button overflows the slot with negative
            margins to keep its hit area. */}
        <span aria-hidden className={HANDLE_SLOT} />
        <span className={CHEVRON_SLOT}>
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${conversationLabel({ title: item.title })} and its threads`}
              onClick={() => setThreadExpanded(item.id, !open)}
              className="-mx-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent/60 pointer-coarse:-mx-3 pointer-coarse:size-9"
            >
              <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
            </button>
          ) : (
            <AttentionDot unread={item.unread ? 1 : 0} needsYou={item.needsYou ? 1 : 0} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex py-1 pr-2">
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
              title={item.step ? `${conversationLabel({ title: item.title })}\nStep: ${item.step}` : (conversationLabel({ title: item.title }))}
              className={cn(
                "flex items-center justify-between gap-2 py-1.5 pr-2 pointer-coarse:py-2.5",
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
                {hasChildren && (
                  <AttentionDot unread={item.unread ? 1 : 0} needsYou={item.needsYou ? 1 : 0} />
                )}
                <ChildGlyph item={item} />
                <span className="min-w-0">
                  <span className="block truncate" title={item.id}>{conversationLabel({ title: item.title })}</span>
                  {showContext && location && (
                    <span className="block truncate text-[10px] font-normal text-sidebar-foreground/50" title={[location.projectName, ...location.path].join(" / ")}>
                      {[location.projectName, ...location.path].join(" / ")}
                    </span>
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
                  {relativeTime(activityAt ?? item.updatedAt)}
                </span>
              )}
            </Link>
          )}
        </div>
        {!renaming && !locked && (
          <DropdownMenu>
            <RowMenuTrigger label={`Actions for ${conversationLabel({ title: item.title })}`} />
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
                rootLabel="Top level"
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
                    !confirm(`"${conversationLabel({ title: item.title })}" is still running. Cancel the run and move it to trash?`)
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
        // 0089: children sit one level deeper on the same grid; the guide
        // line is drawn at the parent's chevron-slot centre.
        <div className="relative">
          <span
            aria-hidden
            className="absolute inset-y-0 w-px bg-sidebar-border/60"
            style={{ left: guideLeft(depth) }}
          />
          {item.children.map((child) => (
            <ConversationRow
              key={child.id}
              item={child}
              projectId={projectId}
              folderId={folderId}
              depth={depth + 1}
              choices={choices}
              showAge={false}
              locations={locations}
            />
          ))}
        </div>
      )}
    </div>
  );
}
