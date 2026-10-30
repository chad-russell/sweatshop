"use client";

import { ChevronRight, Ellipsis, FolderGit2, FolderPlus, MessageSquarePlus } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { cn } from "cn";
import { bucketByAge } from "@/lib/age-buckets";
import { buildSidebarTree } from "@/lib/sidebar-tree";
import { AttentionDot } from "./attention-dot";
import { ConversationRow } from "./conversation-row";
import { useSidebar } from "./context";
import { CHEVRON_SLOT, HANDLE_SLOT, labelInset, rowInset } from "./indent";
import { FolderNodeView, NewFolderRow } from "./folder-node";
import { flattenFolders, type SidebarGroup } from "./types";
import { useDropTarget } from "./use-drop-target";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { folderOrderKey, groupId, orderItems, sectionExpanded } from "@/lib/sidebar-organization";
import { OrderHandle, OrderMenuItems, useContainerOrder } from "./container-order";

const HEADING =
  "text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase";
const ACTION =
  "inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 hover:text-sidebar-foreground";
/** Hover-revealed header actions. In the Chats label they sit in the row; in a
 *  project header they overlay its right edge, so the name only gives up their
 *  room while they show (as conversation rows do with their "⋮"). */
const ACTIONS_REVEAL =
  "flex items-center gap-1 opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 group-has-[[data-state=open]]/head:opacity-100 pointer-coarse:opacity-100";

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
 * One group (a project, or Chats): header, its folder tree, then its own
 * conversations — everything not filed in a folder, split by age (0089: no
 * Unfiled sub-section; the header is the "unfile" drop target). (The
 * top-level Inbox page is a different thing: what needs your attention.)
 *
 * A project is a collapsible header at depth 0 with folders and
 * conversations at depth 1. Chats (no project) is a fixed, non-collapsible
 * label whose folders and conversations sit at depth 0. Every row follows
 * the one indent grid (./indent.ts). Project collapse state persists with
 * the browser's sidebar preferences (key `group:<id>`, which cannot collide
 * with `fld_…` folder ids). Empty projects default closed without saving an
 * explicit choice (0087). Collapsed headers stay drop targets.
 */
export function GroupSection({ group, siblingIds }: { group: SidebarGroup; siblingIds: readonly string[] }) {
  const { editing, setEditing, mounted, expanded, setExpanded, orders } = useSidebar();
  const projectId = group.project?.id ?? null;
  const groupKey = groupId(projectId);
  const total = folderCount(group);
  // Chats has no collapse: it is always open.
  const groupOpen = group.project ? sectionExpanded(expanded, groupKey, total > 0) : true;
  // Depth of the group's folders and conversations.
  const depth = group.project ? 1 : 0;
  const folderScope = folderOrderKey(projectId, null);
  const folders = orderItems(group.folders, orders[folderScope], (folder) => folder.id);
  const choices = useMemo(() => flattenFolders(group.folders), [group.folders]);

  // Header: dropping here sends a conversation (unfiles it) or a folder
  // to this group's top level.
  const header = useDropTarget({ projectId, folderId: null });
  const order = { id: groupKey, scope: "groups", ids: siblingIds, kind: "group" as const, projectId };
  const reorder = useContainerOrder(order, header.props);
  // Chats (no project) is a fixed section pinned after the projects: it
  // is not a sibling of them, so it neither drags nor reorders.
  const reorderable = group.project !== null;
  const headerProps = reorderable ? reorder.props : header.props;

  const creatingRoot =
    editing?.kind === "new-folder" &&
    editing.projectId === projectId &&
    editing.parentId === null;
  // 0040 phase 2: nest start_thread children BEFORE bucketing by age — a
  // root's bucket follows its own updatedAt; a child travels with its
  // parent regardless of the child's own age.
  const looseTree = useMemo(() => buildSidebarTree(group.unfiled), [group.unfiled]);
  // Buckets depend on the local clock/timezone: render the flat list
  // until mounted so server and client markup agree.
  const buckets = mounted ? bucketByAge(looseTree) : null;

  const label = group.project?.name ?? "Chats";
  const addFolder = (
    <button
      type="button"
      aria-label={`New folder in ${label}`}
      title="New folder"
      onClick={() => {
        setExpanded(groupKey, true);
        setEditing({ kind: "new-folder", projectId, parentId: null });
      }}
      className={ACTION}
    >
      <FolderPlus className="size-3.5" />
    </button>
  );

  return (
    <section {...(reorderable ? reorder.containerProps : {})} className={cn("relative", groupOpen ? "pb-4" : "pb-1", reorderable && reorder.indicator)}>
      {group.project ? (
        <div
          {...headerProps}
          className={cn(
            "group/head relative flex items-center justify-between gap-1 rounded-md py-1 pr-2 transition-colors",
            // Make room for the overlaid actions only while they show.
            "focus-within:pr-20 hover:pr-20 has-[[data-state=open]]:pr-20 pointer-coarse:pr-32",
            header.over && "bg-sidebar-accent ring-1 ring-sidebar-ring",
            header.dimmed && !(reorderable && reorder.indicator) && "opacity-40",
          )}
          style={{ paddingLeft: rowInset(0) }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className={HANDLE_SLOT}>
              <OrderHandle label={label} drag={{ kind: "group", id: groupKey, projectId }} />
            </span>
            <span className={CHEVRON_SLOT}>
              <button
                type="button"
                aria-expanded={groupOpen}
                aria-label={`${groupOpen ? "Collapse" : "Expand"} ${label}`}
                onClick={() => setExpanded(groupKey, !groupOpen)}
                className="-mx-1 inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-sidebar-accent/60 pointer-coarse:-mx-3 pointer-coarse:size-9"
              >
                <Chevron open={groupOpen} />
              </button>
            </span>
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
            <span className="font-mono text-[10px] text-sidebar-foreground/40">{total}</span>
            {!groupOpen && (
              <AttentionDot unread={group.attention.unread} needsYou={group.attention.needsYou} />
            )}
          </div>
          <div className={cn(ACTIONS_REVEAL, "absolute inset-y-0 right-2")}>
            <Link
              href={`/?project=${group.project.id}`}
              aria-label={`New chat in ${group.project.name}`}
              title="New chat"
              className={ACTION}
            >
              <MessageSquarePlus className="size-3.5" />
            </Link>
            {addFolder}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={`Actions for ${label} group`} className={ACTION}>
                  <Ellipsis className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <OrderMenuItems {...order} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      ) : (
        // Chats: a plain section label (like PROJECTS), still the unfile
        // drop target and the new-folder button's home.
        <div
          {...headerProps}
          className={cn(
            "group/head relative flex items-center justify-between gap-1 rounded-md px-2 pt-2 pb-1 transition-colors",
            header.over && "bg-sidebar-accent ring-1 ring-sidebar-ring",
            header.dimmed && "opacity-40",
          )}
        >
          <span className={cn(HEADING, "flex items-center gap-1.5")}>
            Chats
            <span className="font-mono text-[10px] text-sidebar-foreground/40 normal-case">{total}</span>
          </span>
          <div className={ACTIONS_REVEAL}>{addFolder}</div>
        </div>
      )}

      {groupOpen && (
        <>
          {creatingRoot && <NewFolderRow projectId={projectId} parentId={null} depth={depth} />}
          {folders.map((node) => (
            <FolderNodeView
              key={node.id}
              node={node}
              projectId={projectId}
              parentId={null}
              depth={depth}
              choices={choices}
              siblingIds={folders.map((folder) => folder.id)}
            />
          ))}

          {buckets
            ? buckets.map(({ bucket, items }) => (
                <div key={bucket}>
                  <div
                    className="pt-1.5 pr-2 pb-0.5 text-[10px] tracking-wide text-sidebar-foreground/40 uppercase"
                    style={{ paddingLeft: labelInset(depth) }}
                  >
                    {bucket}
                  </div>
                  {items.map((item) => (
                    <ConversationRow
                      key={item.id}
                      item={item}
                      projectId={projectId}
                      folderId={null}
                      depth={depth}
                      choices={choices}
                      showAge
                    />
                  ))}
                </div>
              ))
            : looseTree.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  projectId={projectId}
                  folderId={null}
                  depth={depth}
                  choices={choices}
                  showAge={false}
                />
              ))}
        </>
      )}
    </section>
  );
}
