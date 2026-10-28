"use client";

import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { conversationHref } from "@/lib/conversation-href";
import { groupRecent, localDayStart, recentProjection, sectionExpanded, type RecentRange } from "@/lib/sidebar-organization";
import { hasActiveDescendant } from "@/lib/sidebar-tree";
import { AttentionDot } from "./attention-dot";
import { ConversationRow, type RowLocation } from "./conversation-row";
import { useSidebar } from "./context";
import { flattenFolders, type SidebarGroup } from "./types";

/** Calendar boundaries refresh overnight and after a suspended/background tab wakes. */
function useLocalClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      clearTimeout(timer);
      timer = setTimeout(refresh, Math.max(1, localDayStart(current, -1) - current));
    };
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return now;
}

export function RecentConversations({ groups, range, onRangeChange }: {
  groups: readonly SidebarGroup[];
  range: RecentRange;
  onRangeChange: (range: RecentRange) => void;
}) {
  const { mounted, pathname, expanded, setExpanded } = useSidebar();
  const now = useLocalClock();
  const { families, locations } = useMemo(() => recentProjection(groups), [groups]);
  const rowLocations = useMemo(() => {
    const choices = new Map(groups.map((group) => [group.project?.id ?? null, flattenFolders(group.folders)]));
    return new Map<string, RowLocation>([...locations].map(([id, location]) => [id, {
      ...location, choices: choices.get(location.projectId) ?? [],
    }]));
  }, [groups, locations]);
  const buckets = groupRecent(families, range, now);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2 px-2">
        <label htmlFor="recent-conversation-range" className="text-[11px] text-sidebar-foreground/60">Activity</label>
        <select id="recent-conversation-range" value={range}
          onChange={(e) => onRangeChange(e.target.value as RecentRange)}
          className="min-w-0 rounded-md border border-sidebar-border bg-sidebar px-2 py-1 pointer-coarse:py-2 text-xs text-sidebar-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="week">Last 7 days</option>
        </select>
      </div>
      {!mounted ? <p className="px-2 py-2 text-xs text-sidebar-foreground/60">Loading recent conversations…</p> : buckets.length === 0 ? (
        <p className="px-2 py-2 text-xs text-sidebar-foreground/60">No conversations in this period.</p>
      ) : buckets.map(({ bucket, families: rows }) => {
        const key = `recent:${bucket}`;
        const active = rows.some(({ item }) => conversationHref(item) === pathname || hasActiveDescendant(item, pathname, conversationHref));
        const open = active || sectionExpanded(expanded, key, bucket === "Today" || bucket === "Yesterday");
        return (
          <section key={bucket} className="mb-2">
            <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${bucket}`}
              onClick={() => setExpanded(key, !open)}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 pointer-coarse:py-2.5 text-left transition-colors hover:bg-sidebar-accent/60">
              <ChevronRight className={cn("size-3 shrink-0 text-sidebar-foreground/60 transition-transform", open && "rotate-90")} />
              <span className="text-[11px] font-medium uppercase tracking-wide text-sidebar-foreground/60">{bucket}</span>
              <span className="font-mono text-[10px] text-sidebar-foreground/40">{rows.reduce((sum, row) => sum + row.count, 0)}</span>
              {!open && <AttentionDot unread={rows.reduce((sum, row) => sum + row.unread, 0)} needsYou={rows.reduce((sum, row) => sum + row.needsYou, 0)} />}
            </button>
            {open && rows.map(({ item, activityAt }) => (
              <ConversationRow key={item.id} item={item} projectId={null} folderId={null} depth={1} choices={[]}
                showAge locations={rowLocations} showContext activityAt={activityAt} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
