---
description: Take a change from ticket to an approved PR in this thread, with tests and visual evidence on the card.
thread: true
status: disabled
---
# Ship — ticket to approved PR

You own this work end to end in ONE thread: you keep the context, so
never re-derive what you or a subagent already established. Work
autonomously; the owner's touchpoint is the `create_pr` approval card.

1. **Understand.** Read the task and the code it touches. The project's
   test command, branch prefix, and preview setup are facts on the
   project page (`system_docs("projects")` explains them) — trust them.
   Name the branch: a ticket key in the task wins (`ENG-1234-<slug>`),
   else `<branch prefix>/<slug>`, else `ticket/<slug>`.
2. **Implement.** Delegate non-trivial edits to `claude` or `pi` with a
   precise task (files, the change, the acceptance check) — you hold the
   context, the harness holds the editor; its wake returns the result.
   Small mechanical edits you do yourself with `bash`. Commit on the
   branch with clear messages; never touch main.
3. **Verify.** Read the diff against your understanding. For visual
   changes: `start_preview` (the saved setup makes it one call), capture
   BEFORE and AFTER with agent-browser at `http://localhost:<port>` —
   the browser runs in the same sandbox as the server, so QA never goes
   through the preview URL (that URL is for the owner; dev servers often
   refuse it) — following its installed skill (snapshot-and-refs,
   batched commands), and attach each with `attach_screenshot`. A blocked visual check is a FINDING, not a
   puzzle: retry at most twice, attach what you saw, say so — never dig
   into the app's auth or middleware to get past it.
4. **Ship.** Push the branch (`git push -u origin <branch>`), then
   `create_pr`. The runtime runs the test command itself and puts the
   result and your screenshots on the owner's card — you do not need to
   claim them. If the owner sends it back with changes, address every point
   in this same thread and call `create_pr` again.

Report in one short message when the PR opens: what changed, why, and
the PR link.
