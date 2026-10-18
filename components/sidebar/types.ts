// Type-only imports: the shapes are read models (0049: @/lib/read-models,
// away from the store layer, which must never reach the client bundle).
import type {
  FolderNode,
  ShelvedItem,
  SidebarData,
  SidebarGroup,
  SidebarItem,
} from "@/lib/read-models/sidebar";
import type { SidebarTreeItem } from "@/lib/sidebar-tree";

export type { FolderNode, ShelvedItem, SidebarData, SidebarGroup, SidebarItem, SidebarTreeItem };

/** What is being dragged — held in React state because dataTransfer
 *  contents are unreadable during dragover. */
export type Drag =
  | {
      kind: "conversation";
      id: string;
      projectId: string | null;
      folderId: string | null;
    }
  | {
      kind: "folder";
      id: string;
      projectId: string | null;
      parentId: string | null;
      /** The folder and everything below it (cannot be dropped into). */
      subtree: ReadonlySet<string>;
    };

export type Editing =
  | { kind: "new-folder"; projectId: string | null; parentId: string | null }
  | { kind: "rename-folder"; id: string }
  | { kind: "rename-conversation"; id: string };

export interface FolderChoice {
  id: string;
  name: string;
  depth: number;
}

/** Depth-first flattening of a group's folder tree, for "Move to…" menus. */
export function flattenFolders(
  nodes: readonly FolderNode[],
  depth = 0,
  skip?: ReadonlySet<string>,
): FolderChoice[] {
  return nodes.flatMap((node) =>
    skip?.has(node.id)
      ? []
      : [
          { id: node.id, name: node.name, depth },
          ...flattenFolders(node.folders, depth + 1, skip),
        ],
  );
}

/** Ids of a folder and all its descendants. */
export function subtreeIds(node: FolderNode): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const child of node.folders) {
    for (const id of subtreeIds(child)) ids.add(id);
  }
  return ids;
}

/** Every live conversation in the library, any group or depth. */
export function allItems(groups: readonly SidebarGroup[]): SidebarItem[] {
  const collect = (nodes: readonly FolderNode[]): SidebarItem[] =>
    nodes.flatMap((n) => [...n.items, ...collect(n.folders)]);
  return groups.flatMap((g) => [...g.unfiled, ...collect(g.folders)]);
}

export function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  return new Date(ms).toLocaleDateString();
}
