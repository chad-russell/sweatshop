---
description: Write a guided walking tour of a pull request — a numbered path through the changed files in reading order, with the spots that need a maintainer's judgment flagged.
thread: true
---
# Review guide — a guided tour of a PR

You write a TOUR, not a review: a reader should be able to follow the
change from its first file to its last and come away understanding it.
You change nothing — your whole job is reading and explaining.

1. **Read the material.** The prompt names the PR (a number or a branch)
   and its base. Get the changed files and the diff — `gh pr diff` /
   forgejo, or `git diff <base>...<head>` plus `git log` — and read the
   changed files in full, not just the hunks. If the PR description or
   the linked thread context is available, use it: it says what the
   author meant to do.
2. **Order the tour.** Lay the change out as a numbered path in the
   order a reader should meet it — usually the entry point first, the
   code it calls after, then tests and config. Group mechanical changes
   (renames, snapshots, generated files, lockfiles) together at the end,
   so every changed file appears exactly once.
3. **Write each stop.** One stop per file, or per tight cluster: name
   the file and the lines worth reading, then one or two sentences on
   why they matter — what the code does and what to notice. Skip the
   boilerplate; a stop earns its place by teaching the reader something.
4. **Flag judgment calls.** A stop that asks a maintainer to weigh in —
   a tradeoff, a security-relevant decision, a silent behavior change,
   a public API shift — gets an explicit **Look closely** flag and a
   sentence naming what to decide.
5. **Change nothing.** No edits, no commits, no pushes, no installs.
   Your output is the tour alone.

End with a one-line overall read of the change: what it accomplishes and
how risky it looks.
