import type { AttentionCounts, SidebarItem } from "@/db/organize";

/**
 * 0040 phase 2 — the sidebar's parent/child tree. Pure and framework-free
 * so it is unit-tested without React: nesting a `start_thread` child
 * under its parent is a property of whatever FLAT list is currently
 * visible (a folder's items, or a group's Unfiled list), never a global
 * fact — a child whose parent sits in a different folder, project, or
 * shelf (trashed/archived) is simply not in that list, and shows at the
 * top level there, same as before this existed.
 */

/** 0012: statuses where a run row is still working (mirrors
 *  components/sidebar/run-glyph.tsx's isLiveRun — kept here too so this
 *  module stays component-free). Also covers synthetic harness rows
 *  (0046): their statuses are running | completed | failed | cancelled,
 *  so "running" is the only live one. */
const LIVE_RUN_STATUSES = new Set(["running", "waiting"]);

/** Is this conversation doing something right now: a live turn (any
 *  kind), or a live run status for a run / harness row. */
export function isItemRunning(item: Pick<SidebarItem, "kind" | "runStatus" | "activeRunId">): boolean {
  if (item.kind === "run" || item.kind === "harness") {
    return LIVE_RUN_STATUSES.has(item.runStatus ?? "");
  }
  return item.activeRunId != null;
}

export interface SidebarTreeItem extends SidebarItem {
  /** Direct children, oldest-first (so the history reads in order). */
  children: SidebarTreeItem[];
  /** Unread/needsYou summed over every descendant (not this item itself)
   *  — what a COLLAPSED parent's aggregate dot should show. */
  descendantAttention: AttentionCounts;
  /** True if any descendant (not this item itself) isItemRunning. */
  anyDescendantRunning: boolean;
}

/** Would nesting `id` under `parentId` close a cycle? Walks `parentId`'s
 *  own ancestor chain; a visited-twice id also stops (some OTHER cycle
 *  exists upstream — not this call's problem to loop forever over). */
function wouldCycle(id: string, parentId: string, byId: ReadonlyMap<string, SidebarItem>): boolean {
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (cursor === id || seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentConversationId ?? null;
  }
  return false;
}

/**
 * Nest every item whose parent is present (acyclically) elsewhere in
 * the SAME list under that parent, recursively; everything else — no
 * parent, a parent missing from this list, or a parent that would close
 * a cycle — is a root. Roots keep the input's relative order (sort
 * before calling this, same as today); children sort oldest-created
 * first regardless of input order.
 */
export function buildSidebarTree(items: readonly SidebarItem[]): SidebarTreeItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const childIds = new Map<string, string[]>();
  const roots: SidebarItem[] = [];

  for (const item of items) {
    const parentId = item.parentConversationId;
    if (parentId && byId.has(parentId) && !wouldCycle(item.id, parentId, byId)) {
      const siblings = childIds.get(parentId);
      if (siblings) siblings.push(item.id);
      else childIds.set(parentId, [item.id]);
    } else {
      roots.push(item);
    }
  }

  const build = (item: SidebarItem): SidebarTreeItem => {
    const children = (childIds.get(item.id) ?? [])
      .map((id) => byId.get(id)!)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(build);
    const descendantAttention: AttentionCounts = {
      unread: children.reduce((n, c) => n + (c.unread ? 1 : 0) + c.descendantAttention.unread, 0),
      needsYou: children.reduce((n, c) => n + (c.needsYou ? 1 : 0) + c.descendantAttention.needsYou, 0),
    };
    const anyDescendantRunning = children.some((c) => isItemRunning(c) || c.anyDescendantRunning);
    return { ...item, children, descendantAttention, anyDescendantRunning };
  };

  return roots.map(build);
}

/**
 * The default open/closed state for a parent row BEFORE any explicit
 * user choice (components/sidebar/use-thread-expanded.ts) or active-row
 * override applies: open while something below is live or waiting on
 * Chad, closed once it has all settled quietly.
 */
export function defaultExpanded(node: Pick<SidebarTreeItem, "anyDescendantRunning" | "descendantAttention">): boolean {
  return node.anyDescendantRunning || node.descendantAttention.unread > 0 || node.descendantAttention.needsYou > 0;
}

/** True if `href` belongs to a DESCENDANT of `node` (never the node
 *  itself — its own visibility never depends on its own expand state). */
export function hasActiveDescendant(
  node: Pick<SidebarTreeItem, "children">,
  activeHref: string,
  hrefOf: (item: SidebarItem) => string,
): boolean {
  return node.children.some((child) => hrefOf(child) === activeHref || hasActiveDescendant(child, activeHref, hrefOf));
}
