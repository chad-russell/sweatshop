"use client";

import { ChevronRight, FolderGit2, FolderPlus, Layers, MessageSquarePlus } from "lucide-react";
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

function folderCount(group: SidebarGroup): number {
  const below = (nodes: SidebarGroup["folders"]): number =>
    nodes.reduce((n, node) => n + node.items.length + below(node.folders), 0);
  return group.unfiled.length + below(group.folders);
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
 * state persists in the same localStorage set as folder collapsing (keys
 * `group:<id>` / `unfiled:<id>` cannot collide with `fld_…` folder ids).
 * Collapsed headers stay drop targets, so a drag can still land there.
 */
export function GroupSection({ group }: { group: SidebarGroup }) {
  const { editing, setEditing, mounted, collapsed, toggleFolder } = useSidebar();
  const projectId = group.project?.id ?? null;
  const groupKey = `group:${projectId ?? "chats"}`;
  const unfiledKey = `unfiled:${projectId ?? "chats"}`;
  const groupOpen = !collapsed.has(groupKey);
  const unfiledOpen = !collapsed.has(unfiledKey);
  const total = folderCount(group);
  const choices = useMemo(() => flattenFolders(group.folders), [group.folders]);

  // Header: dropping here sends a conversation to Unfiled or a folder
  // to this group's top level.
  const header = useDropTarget({ projectId, folderId: null });
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
    <section className="mb-4">
      <div
        {...header.props}
        className={cn(
          "group/head flex items-center justify-between gap-1.5 rounded-md px-2 py-1 transition-colors",
          header.over && "bg-sidebar-accent ring-1 ring-sidebar-ring",
          header.dimmed && "opacity-40",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button
            type="button"
            aria-expanded={groupOpen}
            aria-label={`${groupOpen ? "Collapse" : "Expand"} ${group.project?.name ?? "Chats"}`}
            onClick={() => toggleFolder(groupKey)}
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
              <span className="truncate">{group.project.name}</span>
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => toggleFolder(groupKey)}
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
            if (!groupOpen) toggleFolder(groupKey);
            setEditing({ kind: "new-folder", projectId, parentId: null });
          }}
          className="inline-flex size-5 pointer-coarse:size-9 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <FolderPlus className="size-3.5" />
        </button>
      </div>

      {groupOpen && (
        <>
          {creatingRoot && <NewFolderRow projectId={projectId} parentId={null} depth={1} />}
          {group.folders.map((node) => (
            <FolderNodeView
              key={node.id}
              node={node}
              projectId={projectId}
              parentId={null}
              depth={1}
              choices={choices}
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
              onClick={() => toggleFolder(unfiledKey)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-sidebar-accent/60"
              style={{ paddingLeft: 8 + INDENT }}
            >
              <Chevron open={unfiledOpen} />
              <Layers className="size-3 shrink-0 text-sidebar-foreground/60" />
              <span className={HEADING}>Unfiled</span>
              <span className="font-mono text-[10px] text-sidebar-foreground/40">
                {group.unfiled.length}
              </span>
              {!unfiledOpen && (
                <AttentionDot
                  unread={group.unfiled.filter((i) => i.unread).length}
                  needsYou={group.unfiled.filter((i) => i.needsYou).length}
                />
              )}
            </button>
            {unfiledOpen &&
              (group.unfiled.length === 0 ? (
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
