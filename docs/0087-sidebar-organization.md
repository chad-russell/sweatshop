# 0087 — Sidebar: quieter empty groups, manual order, and Recent

Status: **implemented — approved by the owner in chat (2026-10-28).**

## Goal

Make conversations easier to reach without scrolling through expanded empty
projects. Preserve the existing project/folder organization, add manual ordering,
and offer an activity-first view across projects.

## Behavior

### Empty sections

- An Unfiled section with zero conversations defaults closed, including when
  its last conversation is filed, archived, or trashed. It remains a visible
  drop target and can be expanded explicitly.
- A project/Chats group with zero conversations anywhere in its folder tree
  also defaults closed. Zero Unfiled alone does **not** close a project that
  has filed conversations.
- Explicit expand/collapse choices win over these defaults. An automatic
  default does not write a lasting preference: when content arrives, a section
  without an explicit choice can open again.
- Keep existing saved collapsed choices. Add explicit expanded overrides so
  opening an empty section is possible without fighting an effect on each render.
- Creating a folder explicitly opens the containing group. Empty groups remain
  available; this is not a hide-empty filter.

### Manual order in Projects view

- Choose **Projects / Recent** from the Conversations heading's three-dot
  menu (owner refinement, approved in chat). Projects is the initial default
  and retains today's organization; the chosen view is checked in the menu.
- Reorder project/Chats groups, and folders among siblings, with drag handles
  and insertion indicators. Add **Move up / Move down** menu actions as the
  keyboard/touch alternative; disable them at the ends of a sibling list.
- Distinguish reordering from filing: folder edge drops reorder; folder body
  drops retain the existing move-into-folder behavior. Conversation dragging
  continues to file whole thread families, never reorder individual children.
- Container drop targets include their trailing spacing and expanded contents,
  with an insertion line at the container boundary. There are no inter-group
  margin dead zones. Folder headers reserve their center for filing; a valid
  descendant target takes priority over the enclosing container.
- Reordered containers retain their chosen order as conversations get updates.
  New containers append in the existing default order (projects alphabetically,
  folders by activity). Removing or moving a folder ignores its stale saved id
  in the old sibling list; it appends at the destination.
- A **Reset order** action restores the current automatic ordering. Individual
  conversations remain newest-first; top-level page links are not reorderable.
- Persist order and selected view locally in the browser, alongside today's
  collapse preferences. This intentionally does not sync ordering across devices.

### Recent view

- Include all live conversations across projects and Chats, whether filed or
  unfiled. Archive, Trash, and search keep their existing separate behavior.
- Flatten the existing sidebar read model, retain each item's original project
  and folder for actions, and build the parent/child tree **before** grouping.
  Reuse the existing conversation row, thread expansion, attention rollups,
  running indicators, and synthetic harness children. No duplicate thread rows.
- Sort roots by the latest conversation activity in their visible subtree,
  newest first, with a stable id tie-break. Synthetic harness timestamps do not
  determine recency. A recently active child therefore brings its family forward.
  This applies only to Recent; existing Unfiled bucketing is unchanged.
- Show the originating project (or Chats) and folder path as muted context on
  root rows; do not repeat a project heading above each family.
- Offer a small range selector: **All time**, **Today**, **Last 7 days**.
  The latter two filter by family activity and keep the matching family intact.
- Within the selected range, use non-overlapping collapsible groups:
  **Today**, **Yesterday**, **Last 7 days**, **Older**. Last 7 days contains
  the remaining days of that window, excluding Today and Yesterday. Hide empty
  groups. Use local calendar-day boundaries, including today in the seven-day
  window, with DST-safe date arithmetic rather than fixed 24-hour subtraction.
- Today and Yesterday default expanded; Last 7 days and Older default closed.
  Persist bucket expansion independently from project/folder expansion. Each
  header shows a conversation-only count and rolled-up attention; harness rows
  never inflate counts. The current conversation's bucket and thread ancestors
  open while it is being viewed, unless an explicit range filter excludes it.
- Recompute boundaries at local midnight and when the tab becomes visible.
  Use hydration-safe snapshots as the current sidebar does. Range and expansion
  choices persist locally; storage failure still permits session-local changes.
- Manual ordering does not apply to Recent; switching views preserves Projects
  order, filing, and expansion preferences.

## Implementation boundaries

- `components/conversation-sidebar.tsx`: compose the view/range controls and
  choose Projects or Recent without changing search or shelf precedence.
- `components/sidebar/group-section.tsx`, `folder-node.tsx`, and the existing
  collapse/context hooks: content-aware defaults and container reorder controls.
- Add a small browser preference store for the new view/order/expansion data,
  following the hydration-safe external-store pattern already in use. Preserve
  existing localStorage keys; validate corrupt or stale values and maintain an
  in-memory fallback when writes are unavailable.
- Pure helpers under `lib/` own order reconciliation and Recent projection/
  grouping. Reuse `lib/sidebar-tree.ts` and the calendar arithmetic in
  `lib/age-buckets.ts`; do not silently change existing Unfiled bucket labels.
- Recent rendering carries original locations so row menus never accidentally
  treat a filed conversation as unfiled. Reordering remains separate from the
  existing organization API and its server-enforced thread-family invariants.
- No dependency, database migration, new endpoint, or alternate persistence
  backend. Keep the existing semantic tokens, typography, and compact styling.

## Acceptance and proof

1. A fresh browser shows the screenshot's empty projects collapsed. Expanding
   one reveals a closed Unfiled row, not a screen of repeated empty-state text.
   A project with filed conversations and zero Unfiled does not auto-collapse.
2. Explicit overrides, content arriving/disappearing, reloads, multiple tabs,
   corrupt preferences, and unavailable localStorage behave predictably.
3. Project and sibling-folder reorder works with pointer and menu controls,
   survives reload/activity updates, and resets cleanly. Existing filing and
   folder reparenting still work; new/deleted/moved ids reconcile correctly.
4. Recent includes filed and unfiled conversations once, retains families and
   harness children, sorts by family conversation activity, and preserves row
   actions' original locations. Collapsed counts/attention stay accurate.
5. Test local-midnight, seven-day, and DST boundaries; ranges; stable ties;
   default and explicit bucket expansion; active descendant reveal; and
   switching between Projects, Recent, search, Archive, and Trash.
6. Capture before/after at the same route and viewport on the base and feature
   branches using agent-browser, including desktop and the mobile drawer.
   Run `./dev exec -- npm run typecheck`, lint, and test before commits.
7. Add one short user-facing CHANGELOG bullet with implementation. Stop when
   these behaviors pass; no sidebar redesign, individual-conversation manual
   ordering, configurable grouping engine, or cross-device preference sync.

## Approval points

- Reordering means project groups and sibling folders, not the static page
  links or individual conversations.
- Ordering/view preferences are per browser, matching existing collapse state.
- Recent uses family activity rather than only the parent's timestamp, and
  includes filed conversations without changing their organization.

## Validation (2026-10-28)

- Container gate: typecheck and lint pass (lint reports existing warnings).
  Full suite: 1,384 passed, 16 opt-in integration checks skipped.
- Rebuilt and served the local production app at
  `http://sweatshop.localhost:3300/`. agent-browser checks passed at desktop
  (1440×1000) and mobile-drawer (390×844) sizes, with before/after screenshots.
- Verified empty defaults and explicit expansion after reload; project menu
  reorder and pointer drag; folder menu reorder, edge drops and body-drop
  reparenting; saved order and Reset order; cross-tab preference updates.
- Six temporary conversations and two folders exercised filed origins,
  child-driven recency, complete-family filtering, bucket expansion, active
  descendant reveal, search/shelf switching, and a simulated next-day tab wake.
  Removed all fixture rows afterward; the original conversation was untouched.
- No added dependency, schema migration, or model call.
- Follow-up refinement: reproduced the inter-row margin dead zone, then swept
  25 collapsed-row and 37 expanded-row boundary points in the browser; every
  valid point accepts a drop. Checked the actual insertion-line CSS, gap-drop
  ordering, wider folder edges, and folder-center filing priority. Verified
  desktop/mobile menu switching and saved checked state. Current full gate:
  1,386 passed, 16 skipped. One unrelated seed-preview test timed out on the
  first run; its isolated rerun and the full rerun both pass unchanged.
