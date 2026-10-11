---
description: Real ticket work: plan approved by Chad first, ship with tests and evidence, fresh-eyes review before the PR.
thread: true
---
# Ticket — planned work to an approved PR

You own this ticket end to end in ONE thread: you keep the context, so
never re-derive what you or a subagent already established. This is
Ship plus two gates: Chad approves the plan before you build, and a
fresh-eyes review runs before the PR.

1. **Understand and plan.** Read the ticket and the code it touches.
   The project's test command, branch prefix, and preview setup are
   facts on the project page (`system_docs("projects")`) — trust them.
   Write a short plan: the branch name (a ticket key in the task wins,
   `ENG-1234-<slug>`, else `<branch prefix>/<slug>`), the changes by
   file/area, how you will verify (tests + preview checks), and what
   you will NOT do. Then `ask_chad` (kind=approval) with that plan and
   wait — his comment is the plan of record; a denial means revise the
   plan, not proceed.
2. **Implement.** Delegate non-trivial edits to `claude` or `pi` with a
   precise task (files, the change, the acceptance check) — you hold
   the context, the harness holds the editor; its wake returns the
   result. Small mechanical edits you do yourself with `bash`. Commit
   on the branch with clear messages; never touch main.
3. **Verify.** Read the diff against the plan. Run the project's test
   command. For visual changes: `start_preview` (the saved setup makes
   it one call), capture BEFORE and AFTER with agent-browser at
   `http://localhost:<port>` — the browser runs in the same sandbox as
   the server, so QA never goes through the preview URL — following
   its installed skill, and attach each with `attach_screenshot`. A
   blocked visual check is a FINDING, not a puzzle: retry at most
   twice, attach what you saw, say so — never dig into the app's auth
   or middleware to get past it.
4. **Fresh eyes.** Before the PR, `start_thread` with the skill
   `"review"` and raw material only: the ticket text, the branch, the
   base branch, where the evidence (screenshots, test output) lives.
   Never your reasoning — the reviewer forms its own judgment. When
   its wake arrives, weigh every finding: fix the real ones (re-verify
   what you change), and say in the PR body which findings you
   declined and why.
5. **Ship.** Push the branch (`git push -u origin <branch>`), then
   `create_pr`. The runtime runs the test command itself and puts the
   result and your screenshots on Chad's card — you do not need to
   claim them. The body summarizes the change, the review's findings,
   and your answers to them. If Chad sends it back with changes,
   address every point in this same thread and call `create_pr` again.

Report in one short message when the PR opens: what changed, why, the
review verdict, and the PR link.
