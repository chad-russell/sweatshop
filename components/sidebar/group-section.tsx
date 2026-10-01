"use client";

import { FolderGit2, FolderPlus, Inbox } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { cn } from "cn";
import { bucketByAge } from "@/lib/age-buckets";
import { ConversationRow } from "./conversation-row";
import { useSidebar } from "./context";
import { FolderNodeView, NewFolderRow } from "./folder-node";
import { flattenFolders, type SidebarGroup } from "./types";
import { useDropTarget } from "./use-drop-target";

const HEADING =
  "text-[11px] font-medium tracking-wide text-sidebar-foreground/60 uppercase";

/**
 * One group (a project, or Chats): header, its folder tree, then the
 * Inbox — everything not filed in a folder, split by age. Filing moves a
 * conversation out of the Inbox, so the Inbox is always "what's left to
 * sort", and an empty Today means nothing new has arrived.
 */
export function GroupSection({ group }: { group: SidebarGroup }) {
  const { editing, setEditing, mounted } = useSidebar();
  const projectId = group.project?.id ?? null;
  const choices = useMemo(() => flattenFolders(group.folders), [group.folders]);

  // Header: dropping here sends a conversation to the Inbox or a folder
  // to this group's top level.
  const header = useDropTarget({ projectId, folderId: null });
  // Inbox: dropping a conversation here unfiles it.
  const inbox = useDropTarget({ projectId, folderId: null, only: "conversation" });

  const creatingRoot =
    editing?.kind === "new-folder" &&
    editing.projectId === projectId &&
    editing.parentId === null;
  // Buckets depend on the local clock/timezone: render the flat inbox
  // until mounted so server and client markup agree.
  const buckets = mounted ? bucketByAge(group.inbox) : null;

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
        {group.project ? (
          <Link
            href={`/p/${group.project.id}`}
            title={`New conversation in ${group.project.name}`}
            className={cn(
              HEADING,
              "flex min-w-0 items-center gap-1.5 transition-colors hover:text-sidebar-foreground",
            )}
          >
            <FolderGit2 className="size-3 shrink-0" />
            <span className="truncate">{group.project.name}</span>
          </Link>
        ) : (
          <span className={HEADING}>Chats</span>
        )}
        <button
          type="button"
          aria-label={`New folder in ${group.project?.name ?? "Chats"}`}
          title="New folder"
          onClick={() => setEditing({ kind: "new-folder", projectId, parentId: null })}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/60 opacity-0 transition-opacity group-focus-within/head:opacity-100 group-hover/head:opacity-100 hover:text-sidebar-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <FolderPlus className="size-3.5" />
        </button>
      </div>

      {creatingRoot && <NewFolderRow projectId={projectId} parentId={null} depth={0} />}
      {group.folders.map((node) => (
        <FolderNodeView
          key={node.id}
          node={node}
          projectId={projectId}
          parentId={null}
          depth={0}
          choices={choices}
        />
      ))}

      <div
        {...inbox.props}
        className={cn(
          "mt-1 rounded-md transition-colors",
          inbox.over && "bg-sidebar-accent/60 ring-1 ring-sidebar-ring",
          inbox.dimmed && "opacity-40",
        )}
      >
        <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5">
          <Inbox className="size-3 shrink-0 text-sidebar-foreground/60" />
          <span className={HEADING}>Inbox</span>
          <span className="font-mono text-[10px] text-sidebar-foreground/40">
            {group.inbox.length}
          </span>
        </div>
        {group.inbox.length === 0 ? (
          <p className="px-2 py-1 text-xs text-sidebar-foreground/40">
            Nothing to sort.
          </p>
        ) : buckets ? (
          buckets.map(({ bucket, items }) => (
            <div key={bucket}>
              <div className="px-2 pt-1.5 pb-0.5 text-[10px] tracking-wide text-sidebar-foreground/40 uppercase">
                {bucket}
              </div>
              {items.map((item) => (
                <ConversationRow
                  key={item.id}
                  item={item}
                  projectId={projectId}
                  folderId={null}
                  depth={0}
                  choices={choices}
                  showAge
                />
              ))}
            </div>
          ))
        ) : (
          group.inbox.map((item) => (
            <ConversationRow
              key={item.id}
              item={item}
              projectId={projectId}
              folderId={null}
              depth={0}
              choices={choices}
              showAge={false}
            />
          ))
        )}
      </div>
    </section>
  );
}
