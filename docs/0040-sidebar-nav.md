# 0040 — Sidebar: pages vs. actions, a Projects index, a quieter footer

Status: **proposed — direction agreed with Chad in chat (2026-10-11) off a
mockup; this doc awaits his approval before any code.** Mockup:
https://artifacts.internal.crussell.io/sweatshop-sidebar-mockup.html
(before/after on a phone drawer, the desktop sidebar with the Archive/Trash
menu, and the `/projects` page).

## Why

The sidebar (`components/conversation-sidebar.tsx`) renders every nav item
in one row style, but they are three different kinds of thing:

- **Pages** — Inbox, Sandboxes, Previews, Settings (navigate somewhere).
- **Actions** — New project (opens a dialog), Agent (opens the panel, mobile
  only), and New chat (a small icon in the header).
- **Meta** — "82 in store", Archive and Trash counters in the footer.

Chad's read on a phone: "they all look the same but some are pages and some
are actions", the footer is odd (Settings usually lives there; Archive/Trash
are views of conversations, not app chrome), and there is no top-level home
for projects, so "New project" has nowhere natural to live.

## What changes

One visual language per kind:

- **Actions are buttons.** A pair at the top of the sidebar: **New chat**
  (filled, the theme's primary — replaces the header pencil icon) and
  **Agent** (outlined, with a `⌘J` hint on md+; today the Agent entry exists
  only below md). Neither is ever a row and neither ever shows an active
  state.
- **Pages are flat rows**, one icon style, filled when the route is active:
  - daily work: **Inbox** (keeps the needs-you / unread badges) and the new
    **Projects**;
  - a hairline, then infrastructure: **Sandboxes** and **Previews**
    (separate rows, per Chad — he uses both enough to keep them apart).
- **Conversations** gets a small-caps section label over the existing group
  list. Its `⋯` menu holds **Archive** and **Trash** (with counts), which
  swap the list for the shelf view exactly as the footer buttons do now.
  While searching, the match count shows beside the search box.
- **Footer** is `⚙ Settings` on the left and the theme button (the existing
  palette cycler, unchanged) on the right — nothing else. "N in store" is
  dropped.
- The header keeps only the wordmark and (drawer mode) the close button.

### `/projects` (new route)

An index of projects: a card per project linking to `/p/<id>` (name, id,
conversation count, a needs-you marker from the same attention data the
sidebar already has), and a **New project** button that opens the existing
dialog. `NewProjectButton` moves from the sidebar into this page's header;
the `NEW_PROJECT_EVENT` seam stays, so ⌘K "New project" keeps working from
anywhere (the dialog must therefore still be mounted globally — it moves
to the layout, trigger-less, rather than into the page).

Project group headers in the sidebar already link to `/p/<id>`; unchanged.
The per-group new-chat / new-folder icons stay on the group header as
they are today (hover/focus-revealed on desktop, always visible under
`pointer-coarse`) — Chad likes that they don't crowd the rows.

## Decisions and non-goals

- **Sandboxes and Previews stay separate rows.** A single "Runtime" page
  was considered and rejected (Chad's call: used separately, often).
- **No theme move.** Moving theme into Settings was considered; Chad prefers
  the footer palette button. Unchanged.
- **No new dependency, no schema change.** The Projects page reads
  existing data (`projects`, repo count via `listProjectRepos`, the layout's
  attention rollup). Card fields beyond those are out of scope.
- Not touching the conversation list internals (groups, folders, drag and
  drop, search results) — only what sits above and below it.
- Wordmark and desktop layout widths are unchanged (`w-64`; drawer
  `min(20rem,85vw)`).

## Implementation sketch

1. `components/sidebar/nav-row.tsx` — one `NavRow` (page) so the four
   hand-copied `Link` blocks in `conversation-sidebar.tsx` collapse into
   data; active-state logic in one place. `NavAction` button variants use
   the existing `Button`.
2. `conversation-sidebar.tsx` — new header/actions/pages/section/footer
   structure; Archive/Trash move behind a `DropdownMenu` (existing ui
   component) on the Conversations label; drop the "in store" total.
3. `app/projects/page.tsx` — server component, `AppHeader` crumbs
   `Projects`, a New project button; no page-context registration (an
   unregistered page reads as `{kind: "other", path}`, which is enough).
4. `components/project/new-project.tsx` — split dialog from trigger so the
   dialog mounts in the root layout (event-driven, as today) and the
   Projects page renders a plain button that dispatches `NEW_PROJECT_EVENT`.
5. Tests: the sidebar has no component tests today, so add a pure-function
   test for the nav active-state rule (`/projects` and `/p/<id>` both
   light Projects; `/sandboxes/<id>` lights Sandboxes) and a store test
   for the project-card read model if it gets its own function.
6. Gate (`typecheck`, `lint`, `test`), then verify on the running preview
   at phone width (this was designed from a phone screenshot) and desktop.
   AGENTS.md's sidebar bullet gets one sentence.

## Open questions

- Should `/p/<id>` light **Projects** in the nav? (Sketch assumes yes — it
  is inside Projects.)
- The agent panel's floating button is md+; with the `Agent` button in the
  sidebar on md+ too, is the floating button redundant? Left alone here;
  revisit after living with it.
