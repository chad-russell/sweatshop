import { afterEach, describe, expect, it, vi } from "vitest";
import type { FolderNode, SidebarGroup, SidebarItem } from "../lib/read-models/sidebar";
import {
  folderOrderKey, groupId, groupRecent, insertRelative, localDayStart, orderedIds, orderItems,
  parseSidebarPreferences, recentBucket, recentProjection, reconcileOrders, reorderEdge, sectionExpanded, sidebarOrderScopes,
} from "../lib/sidebar-organization";
import { createSidebarPreferenceStore } from "../components/sidebar/use-preferences";
import { canDrop } from "../components/sidebar/use-drop-target";

const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
const now = at(10, 28);
function item(id: string, overrides: Partial<SidebarItem> = {}): SidebarItem {
  return { id, title: id, updatedAt: now, createdAt: 1, kind: "chat", runStatus: null,
    parentConversationId: null, activeRunId: null, unread: false, needsYou: false, ...overrides };
}
function folder(id: string, items: SidebarItem[] = [], folders: FolderNode[] = []): FolderNode {
  return { id, name: id, items, folders, count: items.length, activityAt: now, attention: { unread: 0, needsYou: 0 } };
}
function group(unfiled: SidebarItem[] = [], folders: FolderNode[] = [], projectId: string | null = "p1"): SidebarGroup {
  return { project: projectId ? { id: projectId, name: `Project ${projectId}` } : null,
    unfiled, folders, attention: { unread: 0, needsYou: 0 } };
}

afterEach(() => vi.unstubAllGlobals());

describe("sidebar defaults and preferences", () => {
  it("keeps empty groups/Unfiled closed without saving an automatic choice", () => {
    const { expanded } = parseSidebarPreferences(null, null);
    expect(sectionExpanded(expanded, "group:p1", false)).toBe(false);
    expect(sectionExpanded(expanded, "unfiled:p1", false)).toBe(false);
    expect(sectionExpanded(expanded, "group:p1", true)).toBe(true);
    expect(sectionExpanded(expanded, "unfiled:p1", true)).toBe(true);
    expect(expanded).toEqual({});
  });

  it("honors explicit expansion of empty sections and explicit collapse after new activity", () => {
    expect(sectionExpanded({ empty: true }, "empty", false)).toBe(true);
    expect(sectionExpanded({ busy: false }, "busy", true)).toBe(false);
    expect(sectionExpanded({}, "folder")).toBe(true);
  });

  it("migrates old collapsed ids and lets new explicit expansion override them", () => {
    const prefs = parseSidebarPreferences(JSON.stringify({ view: "recent", range: "week", expanded: { "group:p1": true } }),
      JSON.stringify(["group:p1", "fld_1", 42]));
    expect(prefs).toMatchObject({ view: "recent", range: "week", expanded: { "group:p1": true, fld_1: false } });
  });

  it("validates malformed values and deduplicates order ids", () => {
    expect(parseSidebarPreferences("{", "{")).toEqual({ view: "projects", range: "all", orders: {}, expanded: {} });
    expect(parseSidebarPreferences("[]", "null").view).toBe("projects");
    const prefs = parseSidebarPreferences(JSON.stringify({ view: "unknown", range: "no", expanded: { a: "yes", b: false },
      orders: { groups: ["a", "a", null, 3, "b"], bad: 4 } }), null);
    expect(prefs).toEqual({ view: "projects", range: "all", expanded: { b: false }, orders: { groups: ["a", "b"] } });
    expect(sectionExpanded(prefs.expanded, "constructor", false)).toBe(false);
  });

  it("caches snapshots, persists reloads and reads changes from another tab", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    const store = createSidebarPreferenceStore(() => storage);
    const first = store.read();
    expect(store.read()).toBe(first);
    store.update((current) => ({ ...current, view: "recent" }));
    expect(createSidebarPreferenceStore(() => storage).read().view).toBe("recent");
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    storage.setItem("sweatshop.sidebar.preferences", JSON.stringify({ view: "projects", range: "today" }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "sweatshop.sidebar.preferences" }));
    expect(listener).toHaveBeenCalledOnce();
    expect(store.read()).toMatchObject({ view: "projects", range: "today" });
    unsubscribe();
    window.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("retains changes in memory when reads are blocked", () => {
    const store = createSidebarPreferenceStore(() => { throw new Error("blocked"); });
    store.update((current) => ({ ...current, view: "recent", expanded: { empty: true } }));
    expect(store.read()).toMatchObject({ view: "recent", expanded: { empty: true } });
  });

  it("retains changes in memory when writes fail and avoids no-op notifications", () => {
    const store = createSidebarPreferenceStore(() => ({ getItem: () => null, setItem: () => { throw new Error("quota"); } }));
    vi.stubGlobal("window", new EventTarget());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update((current) => current);
    expect(listener).not.toHaveBeenCalled();
    store.update((current) => ({ ...current, range: "week" }));
    expect(store.read().range).toBe("week");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

describe("container ordering", () => {
  it("accepts every point of a padded container, including exact row/gap boundaries", () => {
    const bounds = { top: 100, bottom: 132 }; // 28px header + the formerly dead 4px margin.
    for (let y = 100; y <= 132; y += 0.5) expect(reorderEdge(bounds, y)).not.toBeNull();
    expect(reorderEdge(bounds, 100)).toBe("before");
    expect(reorderEdge(bounds, 128)).toBe("after");
    expect(reorderEdge(bounds, 130)).toBe("after");
    expect(reorderEdge(bounds, 132)).toBe("after");
  });

  it("widens folder edges while retaining a center for filing at all row sizes", () => {
    for (const height of [28, 32, 48]) {
      const bounds = { top: 100, bottom: 100 + height };
      expect(reorderEdge(bounds, 108, true)).toBe("before");
      expect(reorderEdge(bounds, bounds.bottom - 8, true)).toBe("after");
      expect(reorderEdge(bounds, 100 + height / 2, true)).toBeNull();
      expect(reorderEdge(bounds, bounds.bottom, true)).toBe("after");
    }
  });

  it("ignores stale/duplicate ids and appends new containers in default order", () => {
    expect(orderedIds(["a", "b", "new"], ["deleted", "b", "b", "a"])).toEqual(["b", "a", "new"]);
    expect(orderedIds(["b", "a"])).toEqual(["b", "a"]);
    const rows = [{ id: "a", activity: 9 }, { id: "b", activity: 100 }];
    expect(orderItems(rows, ["b", "a"], (row) => row.id)).toEqual([rows[1], rows[0]]);
  });

  it("inserts on either edge without losing siblings", () => {
    expect(insertRelative(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(insertRelative(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(insertRelative(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
    expect(insertRelative(["a", "b"], "gone", "b", "after")).toEqual(["a", "b"]);
  });

  it("scopes folder order to siblings and removes moved/deleted ids", () => {
    const groups = [group([], [folder("a", [], [folder("nested")]), folder("b")]), group([], [], null)];
    const scopes = sidebarOrderScopes(groups);
    expect(scopes.groups).toEqual([groupId("p1"), groupId(null)]);
    expect(scopes[folderOrderKey("p1", "a")]).toEqual(["nested"]);
    const source = folderOrderKey("p1", null);
    const dest = folderOrderKey("p1", "a");
    const reconciled = reconcileOrders({ [source]: ["b", "moved", "a"], [dest]: ["deleted"], gone: ["x"] }, scopes);
    expect(reconciled).toEqual({ [source]: ["b", "a"], [dest]: ["nested"] });
    expect(reconcileOrders({}, scopes)).toEqual({}); // Reset restores automatic ordering.
  });

  it("keeps project reordering separate from filing and retains server-invariant mirrors", () => {
    expect(canDrop({ kind: "group", id: "group:p1", projectId: "p1" }, { projectId: "p1", folderId: null })).toBe(false);
    expect(canDrop({ kind: "conversation", id: "c", projectId: "p1", folderId: null }, { projectId: "p1", folderId: "f" })).toBe(true);
    expect(canDrop({ kind: "conversation", id: "c", projectId: "p1", folderId: null }, { projectId: "p2", folderId: "f" })).toBe(false);
    const drag = { kind: "folder" as const, id: "a", projectId: "p1", parentId: null, subtree: new Set(["a", "nested"]) };
    expect(canDrop(drag, { projectId: "p1", folderId: "nested" })).toBe(false);
    expect(canDrop(drag, { projectId: "p1", folderId: "b" })).toBe(true);
  });
});

describe("Recent projection", () => {
  it("includes filed conversations, preserves families and original row-action locations", () => {
    const root = item("root", { updatedAt: at(9, 1) });
    const child = item("child", { parentConversationId: "root", unread: true, needsYou: true });
    const harness = item("hc_1", { kind: "harness", parentConversationId: "child", updatedAt: at(12, 1), runStatus: "running" });
    const groups = [group([root], [folder("filed", [child, harness])]), group([item("standalone", { updatedAt: at(10, 27) })], [], null)];
    const result = recentProjection(groups);
    expect(result.families.map((family) => family.item.id)).toEqual(["root", "standalone"]);
    const family = result.families[0];
    expect(family).toMatchObject({ activityAt: now, count: 2, unread: 1, needsYou: 1 });
    expect(family.item.children[0].children[0].id).toBe("hc_1");
    expect(family.item.anyDescendantRunning).toBe(true);
    expect(result.locations.get("child")).toEqual({ projectId: "p1", projectName: "Project p1", folderId: "filed", path: ["filed"] });
    expect(result.locations.get("standalone")?.projectName).toBe("Chats");
    expect(root.updatedAt).toBe(at(9, 1)); // Do not rewrite source activity.
  });

  it("deduplicates rows, keeps missing-parent children reachable, and uses stable root ties", () => {
    const a = item("a");
    const b = item("b", { parentConversationId: "not-in-live-library" });
    const { families } = recentProjection([group([b, a], [folder("f", [a])])]);
    expect(families.map((family) => family.item.id)).toEqual(["a", "b"]);
    expect(families.reduce((sum, family) => sum + family.count, 0)).toBe(2);
  });

  it("filters by family activity without dropping older parents or children", () => {
    const groups = [group([item("old", { updatedAt: at(9, 1) }), item("child", { parentConversationId: "old" }),
      item("yesterday", { updatedAt: at(10, 27) }), item("week", { updatedAt: at(10, 22, 0) }), item("older", { updatedAt: at(10, 21, 23) })])];
    const { families } = recentProjection(groups);
    expect(groupRecent(families, "all", now).map((bucket) => bucket.bucket)).toEqual(["Today", "Yesterday", "Last 7 days", "Older"]);
    expect(groupRecent(families, "week", now).map((bucket) => bucket.bucket)).toEqual(["Today", "Yesterday", "Last 7 days"]);
    const today = groupRecent(families, "today", now);
    expect(today).toHaveLength(1);
    expect(today[0].families[0].item.id).toBe("old");
    expect(today[0].families[0].item.children[0].id).toBe("child");
    expect(groupRecent([], "all", now)).toEqual([]);
  });
});

describe("Recent calendar boundaries", () => {
  it("uses local midnight and a seven-calendar-day window with no overlap", () => {
    expect(recentBucket(at(10, 28, 0), now)).toBe("Today");
    expect(recentBucket(at(10, 27, 23), now)).toBe("Yesterday");
    expect(recentBucket(at(10, 26), now)).toBe("Last 7 days");
    expect(recentBucket(at(10, 22, 0), now)).toBe("Last 7 days");
    expect(recentBucket(at(10, 21, 23), now)).toBe("Older");
    expect(localDayStart(now, -1)).toBe(at(10, 29, 0));
  });

  it.each([[3, 9, 23], [11, 2, 25]])("survives DST around %s/%s", (month, day, hours) => {
    const original = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const current = at(month, day);
      expect(localDayStart(current) - localDayStart(current, 1)).toBe(hours * 3_600_000);
      expect(recentBucket(localDayStart(current, 1), current)).toBe("Yesterday");
      expect(recentBucket(localDayStart(current, 6), current)).toBe("Last 7 days");
      expect(recentBucket(localDayStart(current, 6) - 1, current)).toBe("Older");
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
