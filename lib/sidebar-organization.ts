import type { FolderNode, SidebarGroup } from "./read-models/sidebar";
import { buildSidebarTree, type SidebarTreeItem } from "./sidebar-tree";
import { localDayStart } from "./age-buckets";

export { localDayStart } from "./age-buckets";

export type ConversationView = "projects" | "recent";
export type RecentRange = "all" | "today" | "week";
export type RecentBucket = "Today" | "Yesterday" | "Last 7 days" | "Older";
export interface SidebarPreferences {
  view: ConversationView;
  range: RecentRange;
  expanded: Record<string, boolean>;
  orders: Record<string, string[]>;
}

export const DEFAULT_SIDEBAR_PREFERENCES: SidebarPreferences = {
  view: "projects", range: "all", expanded: {}, orders: {},
};
export const groupId = (projectId: string | null) => `group:${projectId ?? "chats"}`;
export const folderOrderKey = (projectId: string | null, parentId: string | null) =>
  `folders:${projectId ?? "chats"}:${parentId ?? "root"}`;

/** Old collapsed choices are defaults only; new explicit choices win. */
export function parseSidebarPreferences(raw: string | null, legacy: string | null): SidebarPreferences {
  const result: SidebarPreferences = { ...DEFAULT_SIDEBAR_PREFERENCES, expanded: {}, orders: {} };
  try {
    const collapsed: unknown = JSON.parse(legacy ?? "null");
    if (Array.isArray(collapsed)) result.expanded = Object.fromEntries(
      collapsed.filter((id): id is string => typeof id === "string").map((id) => [id, false]),
    );
  } catch { /* Corrupt old preferences must not break navigation. */ }
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    if (value.view === "projects" || value.view === "recent") result.view = value.view;
    if (["all", "today", "week"].includes(value.range)) result.range = value.range;
    if (value.expanded && typeof value.expanded === "object" && !Array.isArray(value.expanded)) {
      result.expanded = { ...result.expanded, ...Object.fromEntries(
        Object.entries(value.expanded).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
      ) };
    }
    if (value.orders && typeof value.orders === "object" && !Array.isArray(value.orders)) {
      result.orders = Object.fromEntries(Object.entries(value.orders)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([key, ids]) => [key, [...new Set(ids.filter((id): id is string => typeof id === "string"))]]));
    }
  } catch { /* Use defaults for malformed preferences. */ }
  return result;
}

export function sectionExpanded(expanded: Readonly<Record<string, boolean>>, id: string, defaultOpen = true): boolean {
  return Object.hasOwn(expanded, id) ? expanded[id] : defaultOpen;
}

/** Ignore removed ids; new siblings append in their existing automatic order. */
export function orderedIds(ids: readonly string[], saved: readonly string[] = []): string[] {
  const remaining = new Set(ids);
  const result: string[] = [];
  for (const id of saved) if (remaining.delete(id)) result.push(id);
  return [...result, ...remaining];
}

export function orderItems<T>(items: readonly T[], saved: readonly string[] | undefined, id: (item: T) => string): T[] {
  const byId = new Map(items.map((item) => [id(item), item]));
  return orderedIds([...byId.keys()], saved).map((key) => byId.get(key)!);
}

export function insertRelative(ids: readonly string[], moving: string, target: string, edge: "before" | "after"): string[] {
  if (moving === target || !ids.includes(moving) || !ids.includes(target)) return [...ids];
  const result = ids.filter((id) => id !== moving);
  result.splice(result.indexOf(target) + (edge === "after" ? 1 : 0), 0, moving);
  return result;
}

/** Full targets include inter-row padding; only folder headers reserve a filing center. */
export function reorderEdge(bounds: { top: number; bottom: number }, y: number, filingCenter = false): "before" | "after" | null {
  const height = bounds.bottom - bounds.top;
  if (!filingCenter) return y < bounds.top + height / 2 ? "before" : "after";
  const band = Math.min(12, height / 3);
  if (y <= bounds.top + band) return "before";
  if (y >= bounds.bottom - band) return "after";
  return null;
}

export function sidebarOrderScopes(groups: readonly SidebarGroup[]): Record<string, string[]> {
  const scopes: Record<string, string[]> = { groups: groups.map((group) => groupId(group.project?.id ?? null)) };
  function visit(nodes: readonly FolderNode[], projectId: string | null, parentId: string | null) {
    scopes[folderOrderKey(projectId, parentId)] = nodes.map((node) => node.id);
    for (const node of nodes) visit(node.folders, projectId, node.id);
  }
  for (const group of groups) visit(group.folders, group.project?.id ?? null, null);
  return scopes;
}

export function reconcileOrders(orders: Readonly<Record<string, string[]>>, scopes: Readonly<Record<string, string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(orders)
    .filter(([key]) => Object.hasOwn(scopes, key))
    .map(([key, ids]) => [key, orderedIds(scopes[key], ids)]));
}

export interface SidebarLocation {
  projectId: string | null;
  folderId: string | null;
  projectName: string;
  path: string[];
}
export interface RecentFamily {
  item: SidebarTreeItem;
  activityAt: number;
  count: number;
  unread: number;
  needsYou: number;
}

/** Flatten only the visible library. Never fetch parents from outside this list. */
export function recentProjection(groups: readonly SidebarGroup[]) {
  const items = [] as SidebarGroup["unfiled"];
  const locations = new Map<string, SidebarLocation>();
  for (const group of groups) {
    const projectId = group.project?.id ?? null;
    const projectName = group.project?.name ?? "Chats";
    function collect(rows: SidebarGroup["unfiled"], folderId: string | null, path: string[]) {
      for (const item of rows) {
        if (locations.has(item.id)) continue;
        items.push(item);
        locations.set(item.id, { projectId, projectName, folderId, path });
      }
    }
    function visit(nodes: readonly FolderNode[], path: string[]) {
      for (const node of nodes) {
        const below = [...path, node.name];
        collect(node.items, node.id, below);
        visit(node.folders, below);
      }
    }
    collect(group.unfiled, null, []);
    visit(group.folders, []);
  }
  function summarize(item: SidebarTreeItem): RecentFamily {
    const children = item.children.map(summarize);
    const conversation = item.kind !== "harness";
    return {
      item,
      activityAt: Math.max(conversation ? item.updatedAt : 0, ...children.map((child) => child.activityAt)),
      count: (conversation ? 1 : 0) + children.reduce((sum, child) => sum + child.count, 0),
      unread: (conversation && item.unread ? 1 : 0) + children.reduce((sum, child) => sum + child.unread, 0),
      needsYou: (conversation && item.needsYou ? 1 : 0) + children.reduce((sum, child) => sum + child.needsYou, 0),
    };
  }
  const families = buildSidebarTree(items).map(summarize)
    .sort((a, b) => b.activityAt - a.activityAt || a.item.id.localeCompare(b.item.id));
  return { families, locations };
}

export function recentBucket(activityAt: number, now: number): RecentBucket {
  if (activityAt >= localDayStart(now)) return "Today";
  if (activityAt >= localDayStart(now, 1)) return "Yesterday";
  if (activityAt >= localDayStart(now, 6)) return "Last 7 days";
  return "Older";
}

export function groupRecent(families: readonly RecentFamily[], range: RecentRange, now: number) {
  const cutoff = range === "today" ? localDayStart(now) : range === "week" ? localDayStart(now, 6) : -Infinity;
  const buckets = new Map<RecentBucket, RecentFamily[]>();
  for (const family of families) {
    if (family.activityAt < cutoff) continue;
    const bucket = recentBucket(family.activityAt, now);
    const rows = buckets.get(bucket) ?? [];
    rows.push(family);
    buckets.set(bucket, rows);
  }
  return (["Today", "Yesterday", "Last 7 days", "Older"] as const).flatMap((bucket) => {
    const rows = buckets.get(bucket);
    return rows ? [{ bucket, families: rows }] : [];
  });
}
