---
description: Real ticket work: a plan the owner reviews and approves first, ship with tests and evidence, fresh-eyes review before the PR.
thread: true
---
# Ticket — planned work to an approved PR

You own this ticket end to end in ONE thread: you keep the context, so
never re-derive what you or a subagent already established. This is
Ship plus two gates: the owner approves the plan before you build, and a
fresh-eyes review runs before the PR.

1. **Understand and plan.** Read the ticket and the code it touches.
   The project's test command, branch prefix, and preview setup are
   facts on the project page (`system_docs("projects")`) — trust them.
   Write the plan to `PLAN.md` in the work root — beside the repo
   checkouts, never inside one — with `bash`: the branch name (a ticket
   key in the task wins, `ENG-1234-<slug>`, else
   `<branch prefix>/<slug>`), the changes by file/area, how you will
   verify (tests + preview checks), what you will NOT do, links to any
   mockups (publish them; link, never embed), and the build steps as a
   `- [ ]` checklist. Then `present_plan`.

   **Discuss until approved.** Presenting does not wait: the owner reads the
   card and replies in the thread, as many rounds as it takes. Read
   each message for what it is about — the plan, something else, or
   both — answer it, edit `PLAN.md`, and `present_plan` again with a
   one-line `note`. Each new version says which of the owner's points it
   addressed and which it declined, and why. Until the owner approves you may
   read, explore, and prototype on a scratch branch — no commits on the
   work branch, no pushes. Approval arrives as a `[plan vN approved]`
   message (the owner's note, if any, is part of the plan of record). If the owner
   says it is good in chat ("looks good, go"), call `accept_plan` —
   never start on your own reading of their words.
2. **Implement.** Work the checklist: tick a box in `PLAN.md` as each
   step lands and `present_plan` at milestones so the thread's phase
   shows progress. If the scope changes materially, update the plan and
   `present_plan` with `reapprove: true` before going further.
   Delegate non-trivial edits to `claude` or `pi` with a precise task
   (files, the change, the acceptance check) — you hold the context,
   the harness holds the editor; its wake returns the result. Small
   mechanical edits you do yourself with `bash`. Commit on the branch
   with clear messages; never touch main.
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
   base branch, where the evidence (screenshots, test output) lives,
   and that the approved plan is `PLAN.md` in the work root.
   Never your reasoning — the reviewer forms its own judgment. When
   its wake arrives, weigh every finding: fix the real ones (re-verify
   what you change), and say in the PR body which findings you
   declined and why.
5. **Ship.** Push the branch (`git push -u origin <branch>`), then
   `create_pr`. The runtime runs the test command itself and puts the
   result and your screenshots on the owner's card — you do not need to
   claim them. The body summarizes the change, the review's findings,
   and your answers to them. If the owner sends it back with changes,
   address every point in this same thread and call `create_pr` again.

Report in one short message when the PR opens: what changed, why, the
review verdict, and the PR link.
