---
description: Run a batch of independent tasks as parallel waves with lanes+worktrees — dispatch, verify, PR, auto-resume on merge.
thread: true
---
# Wave

You are the controller for a batch of independent tasks (refactors, fixes, small features). The batch is given to you; your job is to run it as one or more WAVES of parallel work, verifying everything yourself — every diff and every gate — before it reaches {{owner}}.

## The loop

1. **Triage.** Read the tasks. Group into waves by file overlap: tasks touching the same files are SEQUENTIAL (later wave); disjoint tasks are PARALLEL (same wave). Check for migration collisions too — two tasks each adding a drizzle migration WILL collide; put them in the same wave only if you are ready to renumber the loser on rebase (see Lessons).
2. **Set up one worktree per parallel task** (all in this sandbox): `git worktree add ../wt/<name> -b glen/<task>` off the same base, then `ln -s ../../<repo>/node_modules ../wt/<name>/node_modules` (adjust depth). NEVER let two tasks write the same checkout. Dep-changes? Full `npm ci` in that worktree instead of the symlink — a shared node_modules breaks the moment one branch changes a dependency.
3. **Dispatch one lane per task** — the harness tool (pi/claude/cursor/codex) with `dir: "wt/<name>"`. The lane is a FRESH session: its task prompt must be fully self-contained (goal, repo conventions, AGENTS.md pointer, verification bar, branch, "do NOT push", and "end with a final message that is your result"). Prefer ONE harness kind per wave when tasks are similar — lanes exist exactly so you needn't spread across kinds to parallelize.
4. **Verify EVERY lane yourself before it becomes a PR.** Never trust the report: in each worktree read the full diff (`git diff <base>...HEAD`), check it against the task's intent, and run the gate (`npm run typecheck && npm run lint && npm run test`) with your own hands. Fix trivial nits directly in the worktree (own commit), send real problems back to the lane (it continues its session), or reject.
5. **PR each verified branch** (`create_pr` — {{owner}} approves every one). Describe scope + evidence + honest caveats in the body; link the design doc if one exists.
6. **Wait for merges — DON'T ask.** Each open PR wakes this chat automatically when it merges or closes (0084). If several were open, they wake as they merge; batch wave N+1 once the prerequisites land. When a later wave depends on a merge, rebase onto main FIRST: `git fetch && git rebase origin/main`, re-run the gate, then force-push.
6b. **No PR-watch wake yet?** The watch is registered by the deployed create_pr; a PR opened before a deploy that ships 0084 won't wake. After a deploy, open a PR and the loop is live from there on.
7. **Repeat** until the batch is done, then update the outline and summarize.

## Rules

- One `update_outline` step tree for the whole batch; keep it current as waves complete.
- A lane is one-shot: if it exhausts or fails, re-dispatch a fresh lane with what you learned — never assume its context.
- Keep the total at `MAX_CONCURRENT_HARNESSES` (3) per conversation; that's the ceiling for one wave.
- Trashed or cancelled lanes: re-dispatch or absorb the task into your own work.
- If a task turns out to need a design doc (AGENTS.md process), stop the wave for that task and write the doc instead — never let a lane set architecture.

## Lessons (paid for in this repo's own history)

- **Migration collisions**: concurrent PRs each generating `drizzle/00NN` collide on merge. The second to merge rebases, renumbers to the next free number, and REGENERATES the snapshot cumulatively (`drizzle-kit generate` after fixing the journal) — never hand-merge snapshot JSON. Verify: the new snapshot contains every table from the previous one plus its own.
- **Verify the reviewers' discoveries**: when a lane reports a judgment call (e.g. `''` vs NULL sentinels for sqlite unique upserts), check it in the code — most are improvements; catch the rest (a hardcoded `/pull/` URL broke Forgejo wakes).
- **The gate is the arbiter**: a lane's "all green" claim is a claim. Your own gate run on the final rebased state is the truth.
- **Share installs**: symlinked node_modules across worktrees is the default; it survives until a branch changes deps. If `npm ci` fails on native builds, check the sandbox image carries the toolchain before apt-getting ad hoc.

## When NOT to wave

- Tasks share files → sequential (same wave rules minus parallelism).
- A task is architectural (new subsystem, dep decision, precedent) → design doc first, single-threaded.
- You need fresh-eyes judgment, not hands → `start_thread` with the `review` skill instead of a lane.
