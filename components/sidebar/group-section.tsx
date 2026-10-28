"use client";

import { ChevronRight, Ellipsis, FolderGit2, FolderPlus, Layers, MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { cn } from "cn";
import { bucketByAge } from "@/lib/age-buckets";
import { buildSidebarTree } from "@/lib/sidebar-tree";
import { AttentionDot } from "./attention-dot";
import { ConversationRow } from "./conversation-row";
import { useSidebar } from "./context";
import { FolderNodeView, NewFolderRow } from "./folder-node";
import { flattenFolders, type SidebarGroup } from "./types";
import { useDropTarget } from "./use-drop-target";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { folderOrderKey, groupId, orderItems, sectionExpanded } from "@/lib/sidebar-organization";
import { OrderHandle, OrderMenuItems, useContainerOrder } from "./container-order";

const HEADING =
  "text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase";

/** Pixels of left padding per nesting level (matches the folder tree). */
const INDENT = 12;

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "size-3 shrink-0 text-sidebar-foreground/60 transition-transform",
        open && "rotate-90",
      )}
    />
  );
}

/** Conversations only — a synthetic harness row (0046) rides along in
 *  the same list as its conversation but never counts. */
const conversationsOnly = (items: readonly { kind: string }[]): number =>
  items.filter((i) => i.kind !== "harness").length;

function folderCount(group: SidebarGroup): number {
  const below = (nodes: SidebarGroup["folders"]): number =>
    nodes.reduce((n, node) => n + conversationsOnly(node.items) + below(node.folders), 0);
  return conversationsOnly(group.unfiled) + below(group.folders);
}

/**
 * One group (a project, or Chats): header, its folder tree, then
 * Unfiled — everything not filed in a folder, split by age. (The
 * top-level Inbox page is a different thing: what needs your attention.)
 * Filing moves a conversation out of Unfiled, so it is always "what's
 * left to sort".
 *
 * Structure, hinted by indentation: group (0) > folders and Unfiled (1) >
 * age labels and conversations (2). The group and Unfiled collapse;
 * explicit state persists with the browser's sidebar preferences (keys
 * `group:<id>` / `unfiled:<id>` cannot collide with `fld_…` folder ids).
 * Empty sections default closed without saving an explicit choice (0087).
 * Collapsed headers stay drop targets, so a drag can still land there.
 */
export function GroupSection({ group, siblingIds }: { group: SidebarGroup; siblingIds: readonly string[] }) {
  const { editing, setEditing, mounted, expanded, setExpanded, orders } = useSidebar();
  const projectId = group.project?.id ?? null;
  const groupKey = groupId(projectId);
  const unfiledKey = `unfiled:${projectId ?? "chats"}`;
  const total = folderCount(group);
  const groupOpen = sectionExpanded(expanded, groupKey, total > 0);
  const unfiledOpen = sectionExpanded(expanded, unfiledKey, conversationsOnly(group.unfiled) > 0);
  const folderScope = folderOrderKey(projectId, null);
  const folders = orderItems(group.folders, orders[folderScope], (folder) => folder.id);
  const choices = useMemo(() => flattenFolders(group.folders), [group.folders]);

  // Header: dropping here sends a conversation to Unfiled or a folder
  // to this group's top level.
  const header = useDropTarget({ projectId, folderId: null });
  const order = { id: groupKey, scope: "groups", ids: siblingIds, kind: "group" as const, projectId };
  const reorder = useContainerOrder(order, header.props);
  // Unfiled: dropping a conversation here unfiles it.
  const unfiledDrop = useDropTarget({ projectId, folderId: null, only: "conversation" });

  const creatingRoot =
    editing?.kind === "new-folder" &&
    editing.projectId === projectId &&
    editing.parentId === null;
  // 0040 phase 2: nest start_thread children BEFORE bucketing by age — a
  // root's bucket follows its own updatedAt; a child travels with its
  // parent regardless of the child's own age.
  const unfiledTree = useMemo(() => buildSidebarTree(group.unfiled), [group.unfiled]);
  // Buckets depend on the local clock/timezone: render the flat list
  // until mounted so server and client markup agree.
  const buckets = mounted ? bucketByAge(unfiledTree) : null;

  return (
    <section {...reorder.containerProps} className={cn("relative", groupOpen ? "pb-4" : "pb-1", reorder.indicator)}>
      <div
        {...reorder.props}
        className={cn(
          "group/head relative flex items-center justify-between gap-1 rounded-md px-2 py-1 transition-colors",
          header.over && "bg-sidebar-accent ring-1 ring-sidebar-ring",
          header.dimmed && !reorder.indicator && "opacity-40",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <OrderHandle label={group.project?.name ?? "Chats"} drag={{ kind: "group", id: groupKey, projectId }} />
          <button
            type="button"
            aria-expanded={groupOpen}
            aria-label={`${groupOpen ? "Collapse" : "Expand"} ${group.project?.name ?? "Chats"}`}
            onClick={() => setExpanded(groupKey, !groupOpen)}
            className="inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded transition-colors hover:bg-sidebar-accent/60"
          >
            <Chevron open={groupOpen} />
          </button>
          {group.project ? (
            <Link
              href={`/p/${group.project.id}`}
              title={`Open ${group.project.name} — repos, setup, and surfaces`}
              className={cn(
                HEADING,
                "flex min-w-0 items-center gap-1.5 transition-colors hover:text-sidebar-foreground",
              )}
            >
              <FolderGit2 className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{group.project.name}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(groupKey, !groupOpen)}
              className={cn(HEADING, "transition-colors hover:text-sidebar-foreground")}
            >
              Chats
            </button>
          )}
          <span className="font-mono text-[10px] text-sidebar-foreground/40">{total}</span>
          {!groupOpen && (
            <AttentionDot unread={group.attention.unread} needsYou={group.attention.needsYou} />
          )}
        </div>
        {group.project && (
          <Link
            href={`/?project=${group.project.id}`}
            aria-label={`New chat in ${group.project.name}`}
            title="New chat"
            className="inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
          >
            <MessageSquarePlus className="size-3.5" />
          </Link>
        )}
        <button
          type="button"
          aria-label={`New folder in ${group.project?.name ?? "Chats"}`}
          title="New folder"
          onClick={() => {
            setExpanded(groupKey, true);
            setEditing({ kind: "new-folder", projectId, parentId: null });
          }}
          className="inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <FolderPlus className="size-3.5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Actions for ${group.project?.name ?? "Chats"} group`}
              className="inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity group-hover/head:opacity-100 group-focus-within/head:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100">
              <Ellipsis className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            <OrderMenuItems {...order} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {groupOpen && (
        <>
          {creatingRoot && <NewFolderRow projectId={projectId} parentId={null} depth={1} />}
          {folders.map((node) => (
            <FolderNodeView
              key={node.id}
              node={node}
              projectId={projectId}
              parentId={null}
              depth={1}
              choices={choices}
              siblingIds={folders.map((folder) => folder.id)}
            />
          ))}

          <div
            {...unfiledDrop.props}
            className={cn(
              "mt-1 rounded-md transition-colors",
              unfiledDrop.over && "bg-sidebar-accent/60 ring-1 ring-sidebar-ring",
              unfiledDrop.dimmed && "opacity-40",
            )}
          >
            <button
              type="button"
              aria-expanded={unfiledOpen}
              aria-label={`${unfiledOpen ? "Collapse" : "Expand"} Unfiled`}
              onClick={() => setExpanded(unfiledKey, !unfiledOpen)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-sidebar-accent/60"
              style={{ paddingLeft: 8 + INDENT }}
            >
              <Chevron open={unfiledOpen} />
              <Layers className="size-3 shrink-0 text-sidebar-foreground/60" />
              <span className={HEADING}>Unfiled</span>
              <span className="font-mono text-[10px] text-sidebar-foreground/40">
                {conversationsOnly(group.unfiled)}
              </span>
              {!unfiledOpen && (
                <AttentionDot
                  unread={group.unfiled.filter((i) => i.unread).length}
                  needsYou={group.unfiled.filter((i) => i.needsYou).length}
                />
              )}
            </button>
            {unfiledOpen &&
              (conversationsOnly(group.unfiled) === 0 ? (
                <p
                  className="px-2 py-1 text-xs text-sidebar-foreground/40"
                  style={{ paddingLeft: 8 + 2 * INDENT }}
                >
                  Nothing to sort.
                </p>
              ) : buckets ? (
                buckets.map(({ bucket, items }) => (
                  <div key={bucket}>
                    <div
                      className="px-2 pt-1.5 pb-0.5 text-[10px] tracking-wide text-sidebar-foreground/40 uppercase"
                      style={{ paddingLeft: 8 + 2 * INDENT }}
                    >
                      {bucket}
                    </div>
                    {items.map((item) => (
                      <ConversationRow
                        key={item.id}
                        item={item}
                        projectId={projectId}
                        folderId={null}
                        depth={2}
                        choices={choices}
                        showAge
                      />
                    ))}
                  </div>
                ))
              ) : (
                unfiledTree.map((item) => (
                  <ConversationRow
                    key={item.id}
                    item={item}
                    projectId={projectId}
                    folderId={null}
                    depth={2}
                    choices={choices}
                    showAge={false}
                  />
                ))
              ))}
          </div>
        </>
      )}
    </section>
  );
}
