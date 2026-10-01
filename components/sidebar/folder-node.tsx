"use client";

import { ChevronRight, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { cn } from "cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConversationRow } from "./conversation-row";
import { useSidebar } from "./context";
import { InlineName } from "./inline-name";
import { MoveMenu } from "./move-menu";
import { RowMenuTrigger } from "./row-menu-trigger";
import { subtreeIds, type FolderChoice, type FolderNode } from "./types";
import { useDropTarget } from "./use-drop-target";

/** Inline "new folder" row, shown where the folder will be created. */
export function NewFolderRow({
  projectId,
  parentId,
  depth,
}: {
  projectId: string | null;
  parentId: string | null;
  depth: number;
}) {
  const { actions, setEditing } = useSidebar();
  return (
    <div className="flex items-center gap-1.5 px-2 py-1" style={{ paddingLeft: 8 + depth * 12 }}>
      <Folder className="size-3.5 shrink-0 text-sidebar-foreground/60" />
      <InlineName
        label="New folder name"
        placeholder="Folder name"
        onCancel={() => setEditing(null)}
        onSubmit={(name) => {
          setEditing(null);
          void actions.createFolder(name, projectId, parentId);
        }}
      />
    </div>
  );
}

/**
 * A folder in a group's tree: collapsible, draggable, a drop target for
 * conversations and other folders (same group only), with a menu for
 * subfolders, rename, move, and delete (contents move up one level).
 */
export function FolderNodeView({
  node,
  projectId,
  parentId,
  depth,
  choices,
}: {
  node: FolderNode;
  projectId: string | null;
  parentId: string | null;
  depth: number;
  choices: readonly FolderChoice[];
}) {
  const { actions, collapsed, toggleFolder, editing, setEditing, setDrag } = useSidebar();
  const open = !collapsed.has(node.id);
  const target = useDropTarget({ projectId, folderId: node.id });
  const renaming = editing?.kind === "rename-folder" && editing.id === node.id;
  const creatingChild =
    editing?.kind === "new-folder" &&
    editing.projectId === projectId &&
    editing.parentId === node.id;
  const Icon = open ? FolderOpen : Folder;

  return (
    <div>
      <div
        draggable={!renaming}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData("text/plain", node.id);
          e.dataTransfer.effectAllowed = "move";
          setDrag({ kind: "folder", id: node.id, projectId, parentId, subtree: subtreeIds(node) });
        }}
        onDragEnd={() => setDrag(null)}
        {...target.props}
        className={cn(
          "group/row relative rounded-md transition-colors hover:bg-sidebar-accent/60",
          target.over && "bg-sidebar-accent ring-1 ring-sidebar-ring",
          target.dimmed && "opacity-40",
        )}
        style={{ paddingLeft: depth * 12 }}
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
            onClick={() => toggleFolder(node.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-sidebar-foreground/60 transition-transform",
                open && "rotate-90",
              )}
            />
            <Icon className="size-3.5 shrink-0 text-sidebar-foreground/60" />
            {!renaming && <span className="truncate text-sm">{node.name}</span>}
          </button>
          {renaming && (
            <InlineName
              label="Folder name"
              initial={node.name}
              onCancel={() => setEditing(null)}
              onSubmit={(name) => {
                setEditing(null);
                void actions.renameFolder(node.id, name);
              }}
            />
          )}
          {!renaming && (
            <span className="shrink-0 font-mono text-[10px] text-sidebar-foreground/60 group-focus-within/row:invisible group-hover/row:invisible group-has-[[data-state=open]]/row:invisible pointer-coarse:invisible">
              {node.count}
            </span>
          )}
        </div>
        {!renaming && (
          <DropdownMenu>
            <RowMenuTrigger label={`Actions for folder ${node.name}`} />
            <DropdownMenuContent
              align="start"
              className="w-48"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <DropdownMenuItem
                onSelect={() => {
                  if (!open) toggleFolder(node.id);
                  setEditing({ kind: "new-folder", projectId, parentId: node.id });
                }}
              >
                <FolderPlus />
                New subfolder
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing({ kind: "rename-folder", id: node.id })}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <MoveMenu
                rootLabel="Top level"
                currentId={parentId}
                choices={choices.filter((c) => !subtreeIds(node).has(c.id))}
                onPick={(id) => void actions.moveFolder(node.id, id)}
              />
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void actions.deleteFolder(node.id)}
              >
                <Trash2 />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {open && (
        <div>
          {creatingChild && <NewFolderRow projectId={projectId} parentId={node.id} depth={depth + 1} />}
          {node.folders.map((child) => (
            <FolderNodeView
              key={child.id}
              node={child}
              projectId={projectId}
              parentId={node.id}
              depth={depth + 1}
              choices={choices}
            />
          ))}
          {node.items.map((item) => (
            <ConversationRow
              key={item.id}
              item={item}
              projectId={projectId}
              folderId={node.id}
              depth={depth + 1}
              choices={choices}
              showAge={false}
            />
          ))}
          {node.folders.length === 0 && node.items.length === 0 && !creatingChild && (
            <p
              className="px-2 py-1 text-xs text-sidebar-foreground/40"
              style={{ paddingLeft: 8 + (depth + 1) * 12 }}
            >
              Empty
            </p>
          )}
        </div>
      )}
    </div>
  );
}
