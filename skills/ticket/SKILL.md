---
description: Real ticket work, phase by phase — plan (you approve it), implement, review, fixup, ship.
mode: true
---
# Ticket

You coordinate this ticket end to end, but keep your own context small:
each phase's real work goes to a harness (`pi`/`claude`/`cursor`/
`codex`) or a `start_thread` child — the runtime attaches that phase's
instructions to the worker automatically, so your task text only needs
the specifics (branch, what changed, where the evidence is). You hold
the plan, the handles, and the decisions — never the diffs. Call
`update_status` the moment the active phase changes, and again as
checklist items move: the declared phases are the top-level steps
(first one active, the rest pending, until the work says otherwise)
and a phase's checklist is that step's children. Do not tick `PLAN.md`
to report progress — the status is the progress. Plan approval is
{{owner's}}: `present_plan`, iterate on their replies, and wait for a
`[plan vN approved]` message — or call `accept_plan` only when they say
so explicitly in chat — before moving past Plan. Ship, and anything
needing `create_pr` or `present_plan`, you do yourself: workers don't
have those tools. If a `[thread state]` note is present, it is the
current status — if the work has moved, call `update_status`.

## Shared

Branch name: a ticket key in the task wins (`ENG-1234-<slug>`), else
`<branch prefix>/<slug>`. The project's test command, branch prefix,
and preview setup are facts on the project page
(`system_docs("projects")`) — trust them. Never touch main; commit with
clear messages. Verification standard: run the project's test command;
for visual changes, `start_preview` (the saved setup makes it one
call), capture BEFORE and AFTER with agent-browser at
`http://localhost:<port>` — the browser runs in the same sandbox as the
server, so QA never goes through the preview URL — and attach each with
`attach_screenshot`. A blocked visual check is a FINDING, not a puzzle:
retry at most twice, attach what you saw, say so — never dig into the
app's auth or middleware to get past it.

## Phase: Plan

Read the ticket and the code it touches. Write the plan to `PLAN.md` in
the work root — beside the repo checkouts, never inside one — with
`bash`: the branch name, the changes by file/area, how you will verify,
what you will NOT do, links to any mockups (publish them; link, never
embed), and the build steps as a `- [ ]` checklist. You may delegate
drafting or research to a harness, but you own the file and the
presenting.

Then `present_plan`. Presenting does not wait: {{owner}} reads the card
and replies in the thread, as many rounds as it takes — read each
message for what it is about, answer it, edit `PLAN.md`, and
`present_plan` again with a one-line `note` saying which of {{owner's}}
points it addressed and which it declined, and why. Until approved you
may read, explore, and prototype on a scratch branch — no commits on
the work branch, no pushes. Approval arrives as a `[plan vN approved]`
message, or call `accept_plan` if {{owner}} says it is good in chat —
never start on your own reading of their words. Once approved,
`update_status` with Plan done and Implement active.

## Phase: Implement

Work the checklist. Each landed step is a child of Implement on
`update_status` (`done`, `active`, `pending`, `skipped`, or `blocked`)
— that is the progress the header shows, not boxes ticked in `PLAN.md`.
If the scope changes materially, update the plan and `present_plan`
with `reapprove: true` before going further. Delegate non-trivial edits
to a harness with a precise task (files, the change, the acceptance
check); small mechanical edits you do yourself with `bash`.

Before leaving Implement, verify (see Shared). When the checklist is
done and verified, `update_status` with Implement done and Review
active.

## Phase: Review

Fresh eyes, raw material only: `start_thread` with the skill `"review"`
and the ticket text, the branch, the base branch, where the evidence
(screenshots, test output) lives, and that the approved plan is
`PLAN.md` in the work root. Never your reasoning — the reviewer forms
its own judgment and changes nothing; its report is a severity-ranked
list of findings. When its wake arrives, weigh every finding. Nothing
to fix: `update_status` with Review done and Ship active. Real
findings: `update_status` with Review done and Fixup active.

## Phase: Fixup

Send the real findings to a harness with a precise task (what to
change, the acceptance check); small mechanical fixes you do yourself
with `bash`. Re-verify what you change, the same way as Implement
(tests, and BEFORE/AFTER screenshots for anything visual). If the
fixes were material, `update_status` with Fixup done and Review active
for another fresh-eyes pass; trivial fixes go straight to
`update_status` with Fixup done and Ship active.

## Phase: Ship

Push the branch (`git push -u origin <branch>`), then `create_pr`. The
runtime runs the test command itself and puts the result and your
screenshots on {{owner's}} card — you do not need to claim them. The
body summarizes the change, the review's findings, and your answers to
them. If {{owner}} sends it back with changes, `update_status` with
Fixup active and address every point in this same thread, then call
`create_pr` again.

Report in one short message when the PR opens: what changed, why, the
review verdict, and the PR link. Then `update_status` with Ship done.
