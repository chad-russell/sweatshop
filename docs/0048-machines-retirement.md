# 0048 — Machines retirement, phase 2

Status: **DRAFT — proposed 2026-10-18, not yet approved.**

## Why

0037 phase 5 deleted the machine interpreter, its tools, and every write
path; since then `machine_runs` can never hold a live run again. What
remains is read-side residue spread across five subsystems, plus two
tables and several columns nothing will ever write. The same principle
as 0031/0032 applies: delete code and data that answer a question no
live runtime can ask.

The residue, exhaustively (grep `machineRuns` / `machineStageRuns` /
`mr_` / `kind === "run"`):

- `db/machines.ts` (91 lines) — the read store: `getRun`,
  `listStageRuns`, `LIVE_STATUSES`, `getRunBinding`,
  `hydrateRunReadonly`, `MachineError`. Readers: `/r/[runId]` page +
  `app/api/machine-runs/[runId]`, `inspect`, `child-status`, the
  sandbox reaper.
- `app/r/[runId]/page.tsx` + `app/api/machine-runs/[runId]/route.ts` —
  the static run view.
- `db/attention.ts` — run-conversation unread semantics ("a run's
  output is its settled_at"), the `kind: "run"` arm of
  `NeedsYouThread`/`UnreadThread`, `runWhere` joins.
- `db/organize.ts`, `db/projects.ts`, `db/sandbox-view.ts` —
  `kind === "run"` branches (sidebar grouping, project deletion
  cascade, sandbox owner labels).
- `lib/child-status.ts` — the `mr_…` arm (a live child can never again
  be a machine run; the arm returns historical cards at best).
- `lib/sandboxes/reaper.ts` — `LIVE_STATUSES` guard.
- `db/schema.ts` — `machine_runs`, `machine_stage_runs`, and the
  `conversations.kind` "run" value (run conversations point at their
  machine_runs row by id prefix, not FK).

## The one real decision

Run conversations (0012) live in the sidebar, are searchable and
trashable, and `/r/<id>` renders them until purged. Two options:

**A. Freeze rendering, delete the machinery (recommended).** Keep the
`machine_runs`/`machine_stage_runs` TABLES and their rows (history,
zero migration risk), delete every code path above, and render old run
conversations as plain chat transcripts — which they already are: the
run's transcript was imported into `messages` by 0032's importer, and a
run conversation opens like any archived chat. What is lost: the
stage-graph chrome of `/r/<id>` and stage-visit inspect. What is kept:
the words, the search hit, the trash flow. 0032 set the precedent
("anything that is purely historical data can be deleted; this is only
a prototype so far").

**B. Keep the read paths.** Cost: the residue above stays forever, and
every future refactor of attention/organize/child-status carries the
`kind === "run"` branches. Benefit: `/r/<id>`'s stage rendering keeps
working for the ~dozen historical runs.

The deciding fact: attention's run-unread arm can never fire for a NEW
run (none can start), so its only effect today is surfacing OLD settled
runs — which a plain unread-on-conversation rule already covers via the
imported assistant messages. B pays permanent rent for a temporary
chrome.

## Plan (option A)

1. `refactor(attention)`: drop the run arms (`NeedsYouThread.kind`,
   `runWhere`, the settled-at unread join); unread is per-conversation,
   uniformly.
2. `refactor(organize)`: sidebar groups fold run conversations into
   their project group as plain conversations (`kind` stays readable in
   the DB but stops branching code).
3. `refactor(sandboxes)`: reaper drops `LIVE_STATUSES`; owner labels
   read "machine run (historical)" where they used to read live state.
4. `refactor(child-status)`: `mr_…` ids return a plain "historical run"
   value-shape (or 404) — `hc_…` and `c_…` are the live kinds.
5. `refactor(runs)`: delete `/r/[runId]`, `app/api/machine-runs`,
   `db/machines.ts`; run conversations link to `/c/<id>` (their
   conversation row) instead. `inspect` loses the `mr_` arm — its
   description already says `mr_…` targets cannot be live.
6. `chore(schema)`: NO migration (tables stay); a doc note on the two
   tables ("write-dead since 0037 phase 5; rows are history"). If Chad
   later prefers, a one-time script can purge run rows and drop the
   tables — a separate small PR.
7. `docs`: AGENTS.md architecture section shrinks accordingly.

Estimated: ~350 lines deleted, ~40 kept-and-simplified.

## What this doc does NOT decide

- Purging the historical rows themselves (kept — zero-risk default).
- The `machine_stage_runs.route` and `machine_runs.overrides` columns
  (schema stays; already documented historical).
- Any new run-graph feature (0009's original vision stays retired; if a
  graph returns, it returns as a design doc).
