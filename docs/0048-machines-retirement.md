# 0048 — Machines retirement, phase 2

Status: **DRAFT — proposed 2026-10-18, not yet approved. Corrected the
same day after a fresh-eyes review found the first draft's residue list
incomplete and option A's premise wrong.**

## Why

0037 phase 5 deleted the machine interpreter, its tools, and most write
paths; since then `machine_runs` can never hold a live run again. What
remains is read-side residue spread across the app, plus two tables and
several columns nothing will ever write for a new run. The same
principle as 0031/0032 applies: delete code and data that answer a
question no live runtime can ask.

## The residue, exhaustively

**Run view + routing** (all links break together):

- `app/r/[runId]/page.tsx` + `app/api/machine-runs/[runId]/route.ts` —
  the static run view and its API.
- `app/c/[sessionId]/page.tsx` — `kind === "run"` redirects
  `/c/<mr_…>` to `/r/<mr_…>`.
- `lib/conversation-href.ts` (`hrefFor`) and `lib/page-context.ts` —
  route run conversations to `/r/`.
- `components/ai-elements/agent-cards.tsx` (two `/r/` hrefs),
  `components/sidebar/conversation-row.tsx` + `run-glyph.tsx`,
  `lib/sidebar-tree.ts` — sidebar/link render paths for `kind = "run"`.

**Reads of the dead tables:**

- `db/machines.ts` (91 lines) — `getRun`, `listStageRuns`,
  `LIVE_STATUSES`, `getRunBinding`, `MachineError`. Readers: `/r`, the
  run API, `inspect`, `child-status`, the sandbox reaper.
- `db/attention.ts` — `runUnread` (a run's unread moment is
  `machine_runs.settled_at`, NOT a message — 0012), the `"run"` arm of
  `UnreadThread.kind`, and the settled-at unread join.
- `db/sandboxes.ts` (`machine_run` lease arm) and
  `lib/sandboxes/reaper.ts` — `LIVE_STATUSES` guard plus a second
  `machineRuns` read in `boundToSandbox`.
- `app/api/previews/route.ts` — `machineRuns` read inside `boundSandbox`.
- `lib/child-status.ts` — the `mr_…` arm (a live child can never again
  be a machine run).
- `lib/agent/tools/inspect.ts` — the `mr_` targets (stage visits).

**One remaining WRITE:** `db/projects.ts` (project-delete cascade)
nulls `machine_runs.sandbox*` columns — not "all write paths deleted"
as the first draft claimed.

**Schema:** `machine_runs`, `machine_stage_runs`, `conversations.kind`
`"run"`/`"stage"` values (run conversations reference their machine row
by shared id prefix, not FK).

## The one real decision

Run conversations are visible today: sidebar rows with a run glyph,
searchable, `/r/<id>` renders status + stage cards + stage-visit
transcripts. The first draft assumed a run conversation renders fine as
a plain chat — **wrong**: per 0012 a run row carries no message
transcript of its own (the words live in its `stage` conversations'
`messages`, and 0032's importer was eve-era chats). Deleting the run
view outright would turn every historical run link into a 404 or an
empty page.

Options:

**A. Keep rendering, delete only the dead semantics.** Delete
`LIVE_STATUSES` guards, `child-status`'s `mr_` arm, `inspect`'s
live-run framing — everything that exists to answer "is this run live
or about to do something?" (nothing can be). KEEP `/r/[runId]`, the
`/c/` redirect, `hrefFor`'s run arm, the sidebar glyph, `runUnread`,
and `db/machines.ts` as the run view's read store. Cost: the residue
shrinks but persists (~150 lines instead of ~350). Benefit: zero data
loss, zero migration, history stays browsable.

**B. Delete the run view too, make runs plain conversations.** A small
migration backfills each run conversation's `messages` with a synthetic
transcript: the run's prompt as the user row, one summary assistant row
per stage visit (from `machine_stage_runs` + each visit's `messages` —
which DO exist and are readable). Then delete `/r`, the redirect,
`hrefFor`'s arm, the glyph, `runUnread` (plain message-based unread
takes over), and `db/machines.ts`. Cost: a careful migration + the
stage-graph chrome is gone forever. Benefit: the residue goes to ~zero.

## Live-DB evidence (2026-10-18, read-only query on bee)

- `machine_runs`: **12 rows** — 7 completed, 5 cancelled.
- `machine_stage_runs`: 37 rows. Run conversations: 12, none trashed.
- All 12 created 2026-10-10 (the day 0037 phase 5 landed); none since.
- Titles are e2e-test artifacts: "tabs or spaces?", "is a haiku 17
  syllables?", "name one prime", "0012 e2e…", "0014 overlay check…",
  plus one real question ("should a solo developer self-host…").

There is no work product in these tables. Both options below were
priced against "keep history browsable" — the data says there is
nothing worth browsing.

The deciding question, updated: **the ~150 read-path lines (A) and the
backfill migration (B) both preserve garbage.** A third option now
matches the 0032 precedent ("purely historical data can be deleted"):

**C. Purge.** One migration: delete the 12 run conversations (their
`stage` conversations and messages go with them via the existing purge
path), drop `machine_runs` + `machine_stage_runs`, delete every read
path in the residue list INCLUDING `/r`, the redirect, `hrefFor`'s run
arm, the glyph, `runUnread`, and `db/machines.ts`. Residue to zero, no
backfill, no kept tables. Cost: the one real conversation's words go
(they are one question and its answer, Oct 10); nothing else of value
exists to lose.

Recommendation: **C** (or B if that one conversation's words matter —
they can be re-asked in a chat in seconds).

## Plan (option A — the zero-risk default)

1. `refactor(child-status)`: `mr_…` ids return a settled historical
   value-shape; `hc_…` and `c_…` are the live kinds.
2. `refactor(sandboxes)`: reaper drops `LIVE_STATUSES`; the
   `machine_run` lease arm and `boundToSandbox`'s read fold into a
   "historical" comment or go.
3. `refactor(inspect)`: `mr_` reports settle state plainly (no live
   framing).
4. `chore(schema)`: doc notes on the two tables ("write-dead for new
   runs since 0037 phase 5; rows are history; the project-delete
   cascade still nulls sandbox columns — harmless").
5. `docs`: AGENTS.md shrinks accordingly.

Option B adds, before step 1: the backfill migration, then
`refactor(runs)`: delete `/r`, `db/machines.ts`, the redirect, `hrefFor`
run arm, glyph, `runUnread`; search keeps finding run rows (title FTS
already works).

## What this doc does NOT decide

- Purging historical rows (both options keep them).
- Any new run-graph feature (0009's vision stays retired).
