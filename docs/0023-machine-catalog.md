# 0023 — The machine catalog

Status: **draft 2026-10-08 — awaiting Chad's approval.** Roadmap item
1.6, the last substantive piece of the go-live floor. Everything here
follows the 2026-10-06 interview decisions (ROADMAP "Machines and
async"): no fan-out, no reviewer stage kind, no generic subagents —
the catalog is four linear machines, and the seeds ARE the catalog.

## Why

The floor's async machinery (0022) needs working material: the four
machines Chad actually reaches for daily — take a ticket to a PR, fix
a bug properly, get an independent review, think something through.
Today's seeds are two (`think`, `ticket`), and `ticket` predates 0021
routes, the web tools, and any notion of a project's own test command.
This doc specifies the four final definitions and the two small
substrate changes they need.

## The catalog

### `think` — kept as-is

Draft → critique → human decide (loop back optional). Unchanged: no
route pins (both stages are "planning" and ride the global flash
default; a project that wants gloo thinking gets it via its default),
no instruction churn. If it frictions during the trial week, edit then.

### `ticket` — reworked

The change set from the roadmap: **project test command in verify,
branch naming, publish.**

| stage | kind | route | notes |
| --- | --- | --- | --- |
| plan | pi | pinned `{harness:"pi", provider:"glm", model:"glm-5.3-flash"}` | read-only repo inspection; markdown plan; FIRST line `BRANCH: glen/<type>-<slug>` |
| approve | human | — | approve the plan (and its branch name) or end the run |
| implement | claude | default (subscription) | create the branch, follow the plan, commit; no push |
| verify | pi | pinned flash | run the project's test command (brief's "# Project" section), confirm the planned changes exist and are committed; loop to implement on failure, `maxVisits: 3` |
| publish | pi | pinned flash | push the branch, open the PR with `create_pr`, reply with the URL |

Branch naming is now part of the contract: the plan stage names the
branch `glen/<type>-<slug>` (the prefix every agent branch in this
repo already uses; `<type>` = ticket/bugfix/etc., `<slug>` = kebab-case
topic). Later stages read it from the brief's "# Earlier stages" — the
`BRANCH:` first line stays machine-readable.

### `bugfix` — new, mirroring the systematic-debugging skill

The Iron Law becomes the graph: no fix stage before a root-cause
stage, and a red loop before anything.

| stage | kind | route | notes |
| --- | --- | --- | --- |
| reproduce | pi | pinned flash | build the tight RED loop for the reported symptom (one shell command if possible); NO fixes, no hypotheses. First line `RED: <command>`. If it cannot be reproduced, say so and end |
| diagnose | pi | pinned flash | root-cause investigation: read the full error, recent changes, minimize; output the chosen root cause with evidence plus the minimal fix plan. No code changes |
| approve | human | — | gate the root cause + fix plan (the point where Chad sees the diagnosis); approve or end |
| fix | claude | default | turn the RED command into a committed failing test, then ONE fix for the root cause, then green. No "while I'm here" changes |
| verify | pi | pinned flash | RED command green, full project test command green, diff contains only the planned fix; loop to fix, `maxVisits: 3` |
| publish | pi | pinned flash | push, `create_pr`, PR URL; body states the root cause and the red→green evidence |

`reproduce` transitions: `diagnose` (when red) / `end` (when not
reproducible — the outcome IS the finding).

### `review` — new

One agent stage, `review`, `workspace: "project"`, `next: []` (the run
ends with the verdict as its outcome; the parent chat's wake delivers
it). Fresh context per visit is already machine behavior — that is why
there is no reviewer stage kind. The prompt names what to review
(branch, commit range, PR) and any focus; the stage works in the
checkout, reads freely, changes nothing (read-only is BY INSTRUCTION —
agent stages have bash; acceptable trust posture for a personal tool,
revisit if machines ever run untrusted prompts).

Output contract: first line `PASS` or `FIX`, then numbered findings,
each with `file:line` and a concrete suggested change. Severity
prefixed (`blocker:` / `nit:`).

Route: deliberately NOT pinned — review inherits the project default,
so employer projects review on gloo and personal ones on GLM. That is
the one catalog machine where model quality should track the project.

## Substrate changes

**1. `projects.test_command`** (migration 0041, text, nullable).
Set on the project page (the 0018 work-surfaces card, beside the
sandbox image). Semantics: one shell command, run from a repo root,
that must exit 0 — the project's definition of "done". Unset is legal:
verify's instructions then fall back to the repo's own test script
(package.json / Makefile / Cargo) and must SAY which it ran. No
per-repo granularity in v1 — multi-repo projects pick the command that
matters (usually the primary repo's gate).

**2. Brief plumbing.** `runMachine` already passes `workspaceRoot`
into `buildBrief`; it gains the project's test command the same way,
rendered as a `# Project` section (test command, unset noted). Harness
and agent stages read it from the brief — machine definitions stay
project-agnostic, exactly like the workspace note today. This is the
whole mechanism behind "project test command in verify": no tool, no
lookup, the brief carries it.

**3. Seed replacement.** Seeds stay insert-only by default; `seed.mjs`
gains `--replace`: delete the seed ids present in `lib/machines/seeds/`
and reinsert from the files (version resets to 1). Runs keep their
snapshots either way (0009 invariant). The 1.6 deploy runs
`npm run db:seed -- --replace` once — the two rows being replaced are
seed-authored, not user-edited (Chad confirms below). Future catalog
changes: edit seeds + `--replace` again, or the ordinary
`edit_machine` path for one-offs.

## Routes, concretely

"Planning cheap, implementation strong" lands as: pi stages in
ticket/bugfix pinned to `glm-5.3-flash` (mechanical stages where flash
is proven and quota-cheap), claude stages at their subscription
default (strong by construction), `review` unpinned to inherit the
project default, `think` untouched. Pins are ordinary stage routes —
`edit_machine set_route` changes them later without a doc.

## Non-goals

- No research, chore/dependency, or orchestrator machines (interview:
  the async work makes the orchestrator possible LATER, not now).
- No fan-out, no reviewer stage kind, no generic subagents.
- No `create_pr` for agent stages: publish stages are pi harness
  stages, and pi already has the tool (0031). Revisit only when an
  agent stage genuinely needs to publish.
- No machine settings UI — routes and definitions change through the
  JSON tab and agent tools (0031 posture).

## Phases

1. **Substrate** — migration 0041 (`projects.test_command`),
   project-page field, `buildBrief` "# Project" section + run-machine
   wiring; tests: brief carries the command (set and unset), project
   round-trip.
2. **Seeds** — rewrite `ticket.json`, add `bugfix.json` and
   `review.json`, `seed.mjs --replace` (+ npm script passthrough);
   tests: new seeds parse through `parseDefinition`, `--replace` is
   idempotent and leaves run snapshots alone.
3. **Live check** — one real `ticket` run and one `review` on the
   dogfood target (open-bible or qr-codes), confirming the flash pins
   show in `machine_stage_runs.route` and the wake returns the review
   verdict.

## Open questions (for approval)

1. `--replace` reset: OK to delete + reseed `think`/`ticket` once?
   (No user edits exist on either row today.)
2. Branch prefix `glen/<type>-<slug>` — confirm, or prefer another
   shape for machine-authored branches?
3. Bugfix's human gate after diagnosis (not after reproduce, not
   after fix) — confirm.
4. Review's read-only is instructions-only — acceptable?
