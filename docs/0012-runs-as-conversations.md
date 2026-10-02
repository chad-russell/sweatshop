# 0012 — Runs as conversations

Status: **proposed (2026-10-02)** — awaiting Chad's approval.

## Goal

A machine run lives in the same sidebar as chats. It sits in the same
folders, gets archived and trashed the same way, shows up in search and
⌘K, and carries the same attention dots. Starting a run should be as
easy as starting a chat.

This is the first of three steps. 0013 (planned) adds a React Flow graph
of the definition (read-only on runs, editable on machines). 0014
(planned) adds LLM-assisted editing and generation of machines.

## Why

Today (read 2026-10-02):

- **Runs are invisible to the sidebar.** `loadSidebar` reads only
  `conversations`. Runs are listed in exactly one place: the 15-row
  "Recent runs" list on `/machines`.
- **The pieces show up, but the whole doesn't.** Every agent-stage
  visit calls `ensureConversation(stageSessionId)`, so each
  `mr_<run>_<seq>` visit becomes a conversation row. Those rows appear
  as loose, titleless chats in Chats/Unfiled, while the run they belong
  to never appears.
- **Starting a run is awkward.** The only UI entry point is an icon
  button that opens a dialog. It is shown only on the project and Chats
  pages, and there is nothing on the machine's own page.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Model | **One table.** A run *is* a `conversations` row with `kind = 'run'`. The row's id **is** the run id (`mr_…`). | Chad's call: same sidebar, same folders, same behaviour. Every 0007 invariant (folder must be in the same group, archive, trash, purge, rename pinning) and every 0008 signal works on these rows without a parallel implementation. Reusing the id means no join column and no second id to keep in sync. |
| Kinds | `conversations.kind`: `chat` (default) \| `run` \| `stage`. | `stage` marks the per-visit agent conversations so the sidebar, Inbox unread and search can hide them. They stay reachable from the run view. |
| Where run state lives | `machine_runs` is unchanged and stays the source of truth for status, the snapshot, and visits. The conversation row holds only organization (title, folder, archive/trash, last seen). | Keeps the interpreter and store untouched. Each table owns one concern. |
| Creation | `createRun` inserts the conversation row in the **same transaction** as `machine_runs`. `project_id` is copied, and `title` is the first line of the prompt, clipped the way a chat's first message is. | One write path covers all three triggers (route, `start_machine`, the new UI). A run never exists without its row. |
| Titles | v1: the prompt-derived title, renamable (`title_source` pinning as usual). No generated titles. | `lib/titles.ts` summarizes a message transcript, which a run doesn't have. A run-aware generator (prompt plus stage outcomes) is a later, separate change. |
| Routing | Sidebar, search, shelf and palette links go to `/r/<id>` for `run` and to `/c/<id>` otherwise. `/c/<mr_…>` redirects to `/r/…`. | One `hrefFor(item)` helper replaces the hard-coded `/c/` in four components. |
| Needs you | A waiting human gate puts the amber dot on the **run's** row (`needsYou` gains the run id). The Inbox machine-gate card is unchanged. | The gate is the run's question, the same way a pending approval is a chat's question. |
| Unread | A run is unread when it reached `waiting`, `needs-attention`, `completed` or `failed` after `last_seen_at`. This is recorded as a new `machine_runs.settled_at`, stamped by `updateRun` on entering one of those statuses. | A chat is unread when there is assistant output you haven't seen. For a run, that is the moment it stops and wants you. Mid-run stage progress is not "unread"; you'd get a dot every two minutes. |
| Trash | Trashing a run that is `running` or `waiting` cancels it first (the UI confirms). Purge deletes the run, its visits, its `stage` conversations and their messages/harness rows. | A trashed run that keeps spending tokens would be invisible work. Purge must not leave orphan `mr_…` rows behind. |
| Search | v1 matches run rows by title/summary (the existing `conversations_fts`). Hits in `stage` conversations' messages report the **parent run** as the result. | Searching for something an agent stage said should find the run. Stage ids are `<runId>_<seq>`, so the parent comes from the id with no extra column. |

## Schema (one migration)

- `conversations.kind text not null default 'chat'`.
- `machine_runs.settled_at integer` (nullable).
- Backfill: insert a `run` conversation row for every existing
  `machine_runs` row (title from the prompt, timestamps from the run,
  `last_seen_at = updated_at` so history doesn't light up as unread). Set
  `kind = 'stage'` on rows whose id matches `mr_…_<n>`. Stamp
  `settled_at` from `updated_at` for runs already settled.
- `ensureConversation` gains an optional `kind`. The agent-stage step
  passes `stage`.

## Starting runs

- **Composer target.** The new-chat composer (`/` and `/p/<id>`) gets
  a target picker: *Chat* (default) or one of the machines usable in this
  scope (project machines on a project page, workspace-free machines in
  Chats). With a machine selected, send POSTs `/api/machine-runs` and
  navigates to `/r/<id>`. The model and sandbox knobs hide, because the
  machine decides those per stage. This replaces `StartRunButton`'s
  dialog.
- **Machine page.** A "Run" button on `/machines/<id>`. A project
  machine asks which project.
- **⌘K.** A "Run machine…" command opens the composer with that machine
  preselected.

## Run view

- Breadcrumb header like chats: group › folder › title. A rename and
  move menu reuses the row's.
- Clicking a visit's session opens the transcript in a **side panel**
  (the existing `/c` and `/h` renderers in panel mode) instead of leaving
  the run. Full-page links remain.
- The definition graph goes here in 0013.

## Phases

1. **Schema + store.** Migration and backfill, `kind` through
   `ensureConversation`, `createRun` writes the row, `settled_at`,
   trash-cancels-run, purge cascade. Store tests: organize invariants on
   run rows, the backfill, unread/needs-you for runs, purge leaves no
   orphans.
2. **Sidebar + attention.** Hide `stage` rows, add `hrefFor`, the
   `/c/mr_…` redirect, a run icon on rows (and status at a glance:
   running spinner, waiting amber, failed red), search mapping stage hits
   to their parent run.
3. **Starting runs.** Composer target picker, Run on the machine page,
   ⌘K command, delete `StartRunButton`.
4. **Run view.** Breadcrumb header, side-panel transcripts, drop the
   "Recent runs" list on `/machines` (the sidebar replaces it).

A precursor commit, outside this doc, fixes the eve-era leftovers found
while reading. The `/machines/new` starter uses `kind: "eve"` (so every
new machine starts invalid), and the editor's help text and the run
dialog still say "eve".

## Out of scope

- The graph view or editor (0013) and LLM assistance (0014).
- Generated run titles.
- Moving a run between groups (runs are bound to their project the way
  chats are).

## Open questions

1. Should `stage` conversations be hidden from the Inbox's **Unread**
   too, with only the parent run lighting up? Proposed: yes. A stage's
   output is surfaced through the run settling, not separately.
