# 0046 — Sidebar: locked thread groups, harness sessions as children

Status: **approved (PLAN.md reviewed with Chad, 2026-10-17); implementation
on `glen/sidebar-thread-groups`.** A short amendment to 0007 (conversation
organization) and 0040 (the sidebar tree) — no new subsystems, so this
records the invariants rather than a design.

## The problem

Two reports off the 0040 tree, same root shape — the sidebar knew a
conversation could have children, but nothing below the read model did:

1. Moving a parent conversation to a folder left its `start_thread`
   children behind: `moveConversation` wrote `folderId` on one row, so a
   filed parent had unfiled (or differently-filed) children dangling in
   Unfiled. Archive, trash, and delete-forever had the same gap —
   trashing a parent orphans the child to the top level.
2. Harness sessions (background pi/claude/cursor calls, `harness_calls`)
   never appeared in the sidebar at all: they aren't conversations, so
   no read model rendered them. Historical machine runs nested never —
   their parent link lives in `machine_runs.parent_conversation_id`
   (0022), not the conversations column.

## Change A — group locking (store invariants)

The invariant lives in `db/organize.ts`, so drag, the "Move to…" menu,
and the API all get it free:

- A thread **group** is a root conversation plus every descendant, over
  BOTH child kinds: a `start_thread` chat
  (`conversations.parent_conversation_id`) and a historical machine run
  (`machine_runs.parent_conversation_id` — a run conversation's id IS
  its machine_runs id, and that column is the link's only home). Both
  walks share one parent-edge map, so the up-walk and down-walk agree;
  each carries a visited set, so a corrupted parent cycle cannot loop
  (it stops at the node before the repeat).
- `moveConversation` normalizes the dragged id to the topmost ancestor
  and files the **whole group** — root and every descendant — in one
  transaction. The cross-group check runs against the ROOT's project.
- `setArchived` / `setTrashed` cascade the stamp to the group;
  restore clears the group. A shelf never orphans a child.
- `deleteConversationForever` resolves the dragged id's root +
  descendants and purges the whole group through the existing
  per-session teardown loop; a run-kind session anywhere in the group
  keeps its machine_runs purge path (0012).
- `setConversationParent` (db/chat.ts) copies the parent's `folderId`
  onto the child at creation — groups never diverge at the source.
- Migration `0053_group_locking.sql` (data-only) re-files every existing
  child to its root ancestor's folder, fixing Chad's already-diverged
  state on deploy: a recursive CTE for chat children, then a single join
  for runs (one level — a run is never itself a parent) that files each
  run to its parent chat's already-rooted folder.

The UI needs no changes for locking: drops and menus already call
`moveConversation(id)`, and the store normalizes.

## Change B — harness sessions + historical runs as tree children

Read-model only — no rows are created:

- `loadSidebar` injects one synthetic `SidebarItem` per `harness_calls`
  row into the same list as its owning conversation (the parent's folder
  items or Unfiled — wherever the parent landed), with
  `parentConversationId` set, `kind: "harness"`, `runStatus = status`,
  title = the task's first line clipped to ~60 chars, and a `harness`
  field carrying the name for the href. `buildSidebarTree` then nests
  it, rolls up running/attention, and default-expands while live — all
  for free.
- Historical runs (`kind: "run"`) get their tree parent from
  `machine_runs.parent_conversation_id` by a read-time join.
- `conversationHref`: a harness row opens `/h/<harness>/<conversation>`
  (the call's conversationId is its harness session id, 0010).
- `ConversationRow` renders the status glyph and link for harness rows,
  but **no row menu and not draggable** — a session is locked to its
  conversation; organizing one individually would break group locking.
  `isItemRunning` / `isLiveRun` treat a running harness call as live.
- **Counts stay conversation-only**: folder `count`, the Unfiled header
  count, group totals, `countLive`, search, the Archive/Trash shelves,
  and the Inbox never include synthetic rows (`kind !== "harness"`
  where a list is counted). Unread/needsYou stay conversation-level —
  the wake message already flags the parent.
