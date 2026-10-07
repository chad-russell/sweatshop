# 0023 — The machine catalog

Status: **approved 2026-10-08 (chat — PR #42).** All four open
questions answered the same day; the revisions they caused (ticket
revise loop, branch naming) are folded in below. Roadmap item
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
| plan | pi | pinned `{harness:"pi", provider:"glm", model:"glm-5.3-flash"}` | read-only repo inspection; markdown plan; FIRST line `BRANCH: <branch>` (naming below); a re-plan visit incorporates the gate comment (the brief's "# Feedback from Chad") |
| approve | human | — | **Approve** the plan (and its branch name) / **Revise** with a comment → back to plan / **Reject** → end the run |
| implement | claude | default (subscription) | create the branch, follow the plan, commit; no push |
| verify | pi | pinned flash | run the project's test command (brief's "# Project" section), confirm the planned changes exist and are committed; loop to implement on failure, `maxVisits: 3` |
| publish | pi | pinned flash | push the branch, open the PR with `create_pr`, reply with the URL |

The revise loop is NOT new functionality — it is the shape `think`
already runs: the gate card's comment box becomes the next visit's
"# Feedback from Chad" (`GateAnswer` → run-machine feedback →
`buildBrief`), and a transition back to `plan` is an ordinary edge.
No loop bound on plan↔approve: Chad is the bound (he approves or
rejects eventually; a bad plan costs one flash-stage visit).

**Branch naming** (revised per Chad, 2026-10-08 — no `glen/` prefix:
some machines run on employer repos). Three layers, first match wins:

1. **The task names it** — if the prompt carries a ticket/issue key
   (e.g. `ENG-1234`) or an explicit branch, the plan stage MUST use
   it: `<KEY>-<slug>` or the named branch verbatim. This is the Linear
   path — Linear's git integration matches PRs to issues by the key
   in the branch name, and the key rides the run prompt.
2. **The project sets a standing prefix** (`projects.branch_prefix`,
   nullable — e.g. `eng` or `cr`): branches are `<prefix>/<slug>`.
3. **Neither** — generic best practice: `<type>/<slug>` with the
   machine's type (`ticket/…`, `bugfix/…`), kebab-case slug from the
   task.

Later stages read the branch from the brief's "# Earlier stages" —
the `BRANCH:` first line stays machine-readable.

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

**1. Two project fields** (migration 0041, both text, nullable):
`projects.test_command` and `projects.branch_prefix`. Set on the
project page (the 0018 work-surfaces card, beside the sandbox image).
Test command semantics: one shell command, run from a repo root, that
must exit 0 — the project's definition of "done". Unset is legal:
verify's instructions then fall back to the repo's own test script
(package.json / Makefile / Cargo) and must SAY which it ran. Branch
prefix semantics: layer 2 of the naming rules above (layer 1 — a key
in the prompt — needs no configuration). No per-repo granularity in
v1 — multi-repo projects pick the command that matters (usually the
primary repo's gate).

**2. Brief plumbing.** `runMachine` already passes `workspaceRoot`
into `buildBrief`; it gains the project's test command and branch
prefix the same way, rendered as a `# Project` section (each present
or noted unset). Harness and agent stages read it from the brief —
machine definitions stay project-agnostic, exactly like the workspace
note today. This is the whole mechanism behind "project test command
in verify": no tool, no lookup, the brief carries it.

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

1. **Substrate** — migration 0041 (`projects.test_command`,
   `projects.branch_prefix`), project-page fields, `buildBrief`
   "# Project" section + run-machine wiring; tests: brief carries the
   command and prefix (set and unset), project round-trip.
2. **Seeds** — rewrite `ticket.json`, add `bugfix.json` and
   `review.json`, `seed.mjs --replace` (+ npm script passthrough);
   tests: new seeds parse through `parseDefinition`, `--replace` is
   idempotent and leaves run snapshots alone.
3. **Live check** — one real `ticket` run and one `review` on the
   dogfood target (open-bible or qr-codes), confirming the flash pins
   show in `machine_stage_runs.route` and the wake returns the review
   verdict.

## Decisions recorded (Chad, 2026-10-08)

The four draft questions, answered in chat:

1. **`--replace` reset** — approved: delete + reseed `think`/`ticket`
   once (neither row has user edits).
2. **Branch naming** — no `glen/` prefix (employer repos run these
   too). Specifiable per Chad so it plays nice with Linear: a
   ticket/issue key in the prompt wins (layer 1), else the project's
   `branch_prefix` (layer 2), else generic `<type>/<slug>` best
   practice (layer 3). Folded in above.
3. **Bugfix's gate** — after diagnosis, as drafted.
4. **Review's read-only** — instructions-only, as drafted.

Plus one addition from the same chat: the ticket approve gate gains
the **Revise-with-comment → re-plan** transition (existing
functionality — see the ticket section).
