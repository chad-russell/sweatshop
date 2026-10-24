# 0083 — Harness lanes: directory-scoped parallel instances of one harness kind

Status: **draft — awaiting Chad's approval in chat.**

## Why

The cap "at most one running call per harness kind per conversation" (0038
amendment, enforced by `claimHarnessRun` against `harness_runs`'s unique
(session, kind) index) is quietly doing two jobs at once:

1. Its stated job: resource control — each bridge-backed kind holds a
   process and a port in the sandbox; an unbounded pile would starve the
   chat's own turns.
2. A job it was never given: shaping the *work plan*. In
   `c_zEBWfvnI-6IT6aM5gIZAp` (five medium refactors, three independent,
   disjoint-file waves) the controller chat wanted three parallel pi
   instances — one per worktree — and instead spread pi/claude/codex
   across the tasks purely to fit the cap. A concurrency constraint
   silently became a model-selection decision. All three passed the gate,
   but the fit was luck, not judgment.

Meanwhile the session-continuity rule the cap protects — "pi keeps context
across calls" via `chat_harness_state.resumeFrom` keyed (conversation,
kind) — is exactly what makes parallel same-kind calls unsafe today: two
running pis would be two writers on one resume handle, and the next serial
call would resume whichever settled last.

The controller pattern that emerged in that chat (harness works in a
worktree → parent reviews the diff and re-runs the gate itself → create_pr
→ Chad merges) is working well and should get cheaper to run, not be
replaced.

## What changes

### Lanes: an optional `dir` on the four harness tools

`pi`/`claude`/`cursor`/`codex` gain an optional `dir` parameter (relative
to the sandbox work root, e.g. `wt/approvals`):

- **Default (no `dir`)** — exactly today's behavior: workDir ".", resume
  `chat_harness_state` for (conversation, kind), one at a time. Nothing
  changes for existing chats, skills, or tests.
- **With `dir`** — a *lane*: a fresh harness session (no resume) rooted at
  that subdirectory. Same kind may run one lane per distinct dir, plus the
  default lane, at the same time.

The claim key becomes (session, kind, dir), so two pis at different dirs
are different rows — the relaxed constraint is still atomic
(check-then-start inside one sqlite transaction, as today).

### Schema

`harness_runs` gains a nullable `dir` column (default lane = NULL).
Migration rebuilds the unique index `harness_runs_session_kind_idx` as
(session, kind, dir). `harness_events` gains the same nullable `dir`,
rendered as a lane chip in the /h events view when set. The claim's
`same-kind` busy message now says which dir holds the slot ("pi is
already running at wt/approvals — start a lane with dir: … or wait").

### Session identity and events

Session ids are `pi-<conversationId>` today; lanes become
`pi-<conversationId>-<dir-safe-hash>` (short stable hash of the dir —
component-safe, no `/` in session ids). `chat_harness_state` is never
written for lane calls (fresh session every call, by design — a lane is a
one-shot worker, not a continuing collaborator; if a task needs iteration
with context, that's the default lane's job).

### Ports

`HARNESS_BRIDGE_PORTS` maps kind → one port per kind. Lanes of a
bridge-backed kind (claude/cursor/codex) draw from a small per-sandbox
lane-port pool (4 ports, say 4600-4603), granted by the claim and released
at settle. Exhaustion is a value-shaped busy ("all lane ports in use — 2
lanes of claude are running").

### Runner gates and outlines

`runnerGate`'s route pinning is unchanged (it validates the kind's route,
not the lane). Outline steps are unaffected: a lane call still carries the
outline handoff text (goal + active subtree) — the lane is a worker for
that step, not a new outline owner.

### The controller loop stays the chat's job (non-goal: no new scheduler)

Lanes do not add orchestration. The chat still decides waves, still
reviews diffs, still opens PRs. 0084 (git events) removes the manual
"say the word when merged" sync point; lanes remove the harness
arbitrariness. The two compose: dispatch N lanes → review → PR →
auto-wake on merge → next wave.

## Decisions & alternatives

- **Why not separate sandboxes per parallel task?** Tried in review of
  c_zEBWfvnI: worktrees in one warm sandbox won on every axis that
  mattered there (one 1.8G install shared, warm caches, one-command diff
  review of all lanes, no re-clone/re-install per task). Separate
  sandboxes remain right for: dep-touching tasks (shared node_modules
  symlink breaks), per-branch services/migrations, untrusted code, heavy
  concurrent builds that contend on caches. `start_thread {fresh: true}`
  already covers that case and stays the answer.
- **Why not `start_thread` lanes instead?** Child threads each get their
  own harness instances already — but each child is a whole chat: its own
  budget accounting, its own transcript, its own wake. For "run these 3
  refactors in 3 worktrees and show me the diffs" that's ceremony without
  benefit. Lanes are the lightweight middle.
- **Why not a `worktree: true` flag instead of `dir`?** Rejected: `dir`
  composes (any subdirectory — a monorepo package, a scratch dir, a
  worktree), worktree creation stays the chat's explicit `bash` choice
  (branch names, base commits, node_modules linking are work-plan
  decisions, not tool decisions).
- **Max total concurrency unchanged** — `MAX_CONCURRENT_HARNESSES = 3`
  still bounds all lanes + default per conversation. Raising it is a knob
  turn away if lanes prove out; 3 is what a reviewing human can actually
  review.

## Testing

- Claim unit tests: same (session, kind, dir) collides; different dirs
  coexist; default lane collides with itself; cap still enforced across
  lanes; lane-port exhaustion value-shapes busy.
- startHarnessCall: lane call never reads/writes `chat_harness_state`;
  session id derives from dir hash; bridge lane port granted/released.
- UI: /h events view shows lane chip; chat card unchanged (lane calls are
  ordinary harness calls).
- Gate green (typecheck, lint, 126-file suite).

## Rollout

One PR, behind nothing — default behavior is bit-identical. The relaxed
constraint only appears when a model explicitly passes `dir`. Docs:
AGENTS.md harness bullet updated (one sentence), this doc linked.
