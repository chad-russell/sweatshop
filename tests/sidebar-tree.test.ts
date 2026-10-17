import { describe, expect, it } from "vitest";
import type { SidebarItem } from "../db/organize";
import {
  buildSidebarTree,
  defaultExpanded,
  hasActiveDescendant,
  isItemRunning,
  type SidebarTreeItem,
} from "../lib/sidebar-tree";

/**
 * 0040 phase 2 — the sidebar's parent/child tree: nesting, orphans
 * (missing/cross-group parents), cycle guards, ordering, and the
 * default-expand rule. Pure, no React.
 */

let n = 0;
function item(overrides: Partial<SidebarItem> = {}): SidebarItem {
  n += 1;
  return {
    id: overrides.id ?? `c_${n}`,
    title: overrides.title ?? null,
    updatedAt: overrides.updatedAt ?? n,
    createdAt: overrides.createdAt ?? n,
    kind: overrides.kind ?? "chat",
    runStatus: overrides.runStatus ?? null,
    parentConversationId: overrides.parentConversationId ?? null,
    activeRunId: overrides.activeRunId ?? null,
    unread: overrides.unread ?? false,
    needsYou: overrides.needsYou ?? false,
  };
}

describe("buildSidebarTree", () => {
  it("nests a child under its parent, recursively (grandchildren too)", () => {
    const grandparent = item({ id: "gp", createdAt: 1 });
    const parent = item({ id: "p", createdAt: 2, parentConversationId: "gp" });
    const child = item({ id: "c", createdAt: 3, parentConversationId: "p" });
    const tree = buildSidebarTree([grandparent, parent, child]);

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("gp");
    expect(tree[0].children.map((c) => c.id)).toEqual(["p"]);
    expect(tree[0].children[0].children.map((c) => c.id)).toEqual(["c"]);
    expect(tree[0].children[0].children[0].children).toEqual([]);
  });

  it("shows a conversation at the top level when its parent is missing from this list", () => {
    // Deleted → null, trashed, archived, or simply filed elsewhere — from
    // this list's point of view they all look the same: no such parent id.
    const orphan = item({ id: "o", parentConversationId: "gone" });
    const tree = buildSidebarTree([orphan]);
    expect(tree).toEqual([{ ...orphan, children: [], descendantAttention: { unread: 0, needsYou: 0 }, anyDescendantRunning: false }]);
  });

  it("cross-group parent: a child nests only when its parent is IN THIS SAME list", () => {
    const parent = item({ id: "p" });
    const child = item({ id: "c", parentConversationId: "p" });
    // The parent is filed in a different folder/group — only the child's
    // list is passed here, so it must surface as a root, not vanish.
    const childOnly = buildSidebarTree([child]);
    expect(childOnly).toHaveLength(1);
    expect(childOnly[0].id).toBe("c");
    expect(childOnly[0].children).toEqual([]);

    // Pass both (same list = same folder) and it nests as normal.
    const both = buildSidebarTree([parent, child]);
    expect(both).toHaveLength(1);
    expect(both[0].children.map((c) => c.id)).toEqual(["c"]);
  });

  it("guards against cycles: a self-parent and a longer cycle both stay roots", () => {
    const selfParent = item({ id: "s", parentConversationId: "s" });
    expect(buildSidebarTree([selfParent])[0].children).toEqual([]);
    expect(buildSidebarTree([selfParent]).map((r) => r.id)).toEqual(["s"]);

    const a = item({ id: "a", parentConversationId: "c" });
    const b = item({ id: "b", parentConversationId: "a" });
    const c = item({ id: "c", parentConversationId: "b" });
    const tree = buildSidebarTree([a, b, c]).map((r) => r.id).sort();
    // Every member of the cycle is refused as a parent, so all three
    // surface as roots — nothing silently disappears.
    expect(tree).toEqual(["a", "b", "c"]);
  });

  it("sorts children oldest-created first, regardless of input order", () => {
    const parent = item({ id: "p" });
    const second = item({ id: "second", parentConversationId: "p", createdAt: 200 });
    const first = item({ id: "first", parentConversationId: "p", createdAt: 100 });
    const third = item({ id: "third", parentConversationId: "p", createdAt: 300 });
    const tree = buildSidebarTree([parent, second, first, third]);
    expect(tree[0].children.map((c) => c.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps the input's relative order for roots (top-level sorting is the caller's job)", () => {
    const b = item({ id: "b", updatedAt: 1 });
    const a = item({ id: "a", updatedAt: 2 });
    // Caller already sorted by updatedAt desc before calling in; the
    // tree builder must not reorder roots on its own.
    const tree = buildSidebarTree([a, b]);
    expect(tree.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("rolls up descendant attention and running state (not including the node itself)", () => {
    const parent = item({ id: "p", unread: true });
    const child = item({ id: "c", parentConversationId: "p", needsYou: true });
    const grandchild = item({ id: "g", parentConversationId: "c", activeRunId: "wr_1" });
    const tree = buildSidebarTree([parent, child, grandchild]);
    const p = tree[0];
    // Parent's OWN unread does not count toward its own descendantAttention.
    expect(p.descendantAttention).toEqual({ unread: 0, needsYou: 1 });
    expect(p.anyDescendantRunning).toBe(true);
    const c = p.children[0];
    expect(c.descendantAttention).toEqual({ unread: 0, needsYou: 0 });
    expect(c.anyDescendantRunning).toBe(true); // its own child (grandchild) is running
  });
});

describe("isItemRunning", () => {
  it("a chat is running iff it has a live turn", () => {
    expect(isItemRunning(item({ kind: "chat", activeRunId: "wr_1" }))).toBe(true);
    expect(isItemRunning(item({ kind: "chat", activeRunId: null }))).toBe(false);
  });

  it("a run row is running/waiting by its status, not activeRunId", () => {
    expect(isItemRunning(item({ kind: "run", runStatus: "running", activeRunId: null }))).toBe(true);
    expect(isItemRunning(item({ kind: "run", runStatus: "waiting", activeRunId: null }))).toBe(true);
    expect(isItemRunning(item({ kind: "run", runStatus: "completed", activeRunId: null }))).toBe(false);
  });

  it("a harness row is running by its status (0046: only \"running\" is live)", () => {
    expect(isItemRunning(item({ kind: "harness", runStatus: "running", activeRunId: null }))).toBe(true);
    expect(isItemRunning(item({ kind: "harness", runStatus: "completed", activeRunId: null }))).toBe(false);
    expect(isItemRunning(item({ kind: "harness", runStatus: "failed", activeRunId: null }))).toBe(false);
    expect(isItemRunning(item({ kind: "harness", runStatus: "cancelled", activeRunId: null }))).toBe(false);
  });

  it("a harness call nests under its conversation and rolls up as running (0046)", () => {
    const parent = item({ id: "p" });
    const call = item({
      id: "hc_1",
      kind: "harness",
      runStatus: "running",
      parentConversationId: "p",
      createdAt: 50,
    });
    const [tree] = buildSidebarTree([parent, call]);
    expect(tree.id).toBe("p");
    expect(tree.children.map((c) => c.id)).toEqual(["hc_1"]);
    expect(tree.anyDescendantRunning).toBe(true);
    // Settled, the call stops rolling up.
    const settled = buildSidebarTree([parent, { ...call, runStatus: "completed" }]);
    expect(settled[0].anyDescendantRunning).toBe(false);
  });
});

describe("defaultExpanded", () => {
  const node = (over: Partial<Pick<SidebarTreeItem, "anyDescendantRunning" | "descendantAttention">>) => ({
    anyDescendantRunning: false,
    descendantAttention: { unread: 0, needsYou: 0 },
    ...over,
  });

  it("defaults open while something below is live or waiting on Chad", () => {
    expect(defaultExpanded(node({ anyDescendantRunning: true }))).toBe(true);
    expect(defaultExpanded(node({ descendantAttention: { unread: 1, needsYou: 0 } }))).toBe(true);
    expect(defaultExpanded(node({ descendantAttention: { unread: 0, needsYou: 1 } }))).toBe(true);
  });

  it("defaults closed once everything below has settled quietly", () => {
    expect(defaultExpanded(node({}))).toBe(false);
  });
});

describe("hasActiveDescendant", () => {
  const hrefOf = (i: { id: string }) => `/c/${i.id}`;

  it("is true only for a STRICT descendant, never the node itself", () => {
    const parent = item({ id: "p" });
    const child = item({ id: "c", parentConversationId: "p" });
    const grandchild = item({ id: "g", parentConversationId: "c" });
    const [tree] = buildSidebarTree([parent, child, grandchild]);

    expect(hasActiveDescendant(tree, "/c/p", hrefOf)).toBe(false); // itself
    expect(hasActiveDescendant(tree, "/c/c", hrefOf)).toBe(true); // direct child
    expect(hasActiveDescendant(tree, "/c/g", hrefOf)).toBe(true); // grandchild
    expect(hasActiveDescendant(tree, "/c/other", hrefOf)).toBe(false);
  });
});
