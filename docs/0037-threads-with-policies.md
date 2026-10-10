# 0037 — Threads with policies: one concept for chats and machines

Status: **draft 2026-10-10 — direction agreed with Chad in chat: unify
chats and machines; a machine becomes a policy attached to one
contextual thread.** Evidence: TRIAL-RUNS runs 1–4 (WYC-1589).

## Why

Four runs of the same ticket split cleanly in two:

- **The substrate held.** Durable runs, human gates as policy, the
  deterministic `publish`, the sandbox/preview bindings, and
  `attach_screenshot` evidence all worked. Run 4 used every one of them.
- **Amnesiac stages were the cost.** Every staged failure (runs 2–3) was a
  stage re-deriving what an earlier stage knew. Measured from the DB: the
  implement stages produced 170–255 KB of harness events, and verify got
  a brief that cut that to a 1–2 KB outcome, plus the checkout. Verify
  then spent 400–600 KB rebuilding it and never finished. Run 4's one
  `flow` stage kept its 173 KB thread and finished in 9½ minutes with the
  best fix of the four runs.

The checkout carried context because it *is* the work. Prose briefs
failed because a summary drops the decisions behind the work. The fix is
not better briefs. It is to stop splitting one piece of work across
conversations.

`flow` still has the bug inside it: "request changes" at its gate starts
a **new visit**, a fresh conversation that gets the brief plus Chad's
comment. Run 4 never hit this because Chad rejected. The first revise
loop would land back in run-3 territory.

Runs already *are* conversations (0012: `kind = 'run'`, same id). What
keeps them separate is the split into stage conversations. Remove it,
and one concept is left.

## The model

**A thread is a conversation. A policy is an optional declaration
attached to a thread.** The policy says three things:

1. **Checkpoints**: named points where the thread pauses for Chad (`plan`,
   `pr`). It never pauses anywhere else.
2. **Guarantees**: what the runtime enforces deterministically, never by
   asking the model:
   - a checkpoint's requirements (a PR proposal exists; screenshots were
     attached);
   - **checks**: commands the runtime itself runs at the checkpoint,
     such as the project's test command, with the results shown on the
     card;
   - **actions** on approval: `publish` pushes the approved proposal and
     opens the PR (0034's step, moved).
3. **Fresh branches**: work that must deliberately *not* share the
   thread's context. The main case is an independent review, which sees
   the ticket, diff and evidence but not the author's reasoning. Its
   findings come back to the parent as a wake (0022).

Everything between checkpoints is one thread doing its own work. It
delegates heavy edits to pi/claude as background harness calls (0022),
whose wakes resume it.

### Catalog (replaces the machine seeds)

| Policy | Checkpoints | Guarantees | Fresh branch |
| --- | --- | --- | --- |
| *(none)* | — | — | — |
| **Ship** (today's `flow`) | `pr` | proposal exists; test check; publish on approve | — |
| **Ticket** | `plan`, `pr` | as Ship, plus screenshots for visual work | review before `pr` |
| **Review** | — | thread starts fresh; output is findings | (it *is* the branch) |

`bugfix` and `think` reduce to Ship or none plus instructions; they
retire as separate entries unless the trial shows a need for them.

## Runtime

The rule from 0034 still applies: approval happens where the runtime
can suspend natively. For a thread, the cleanest place to suspend is
**between turns**. So a checkpoint ends the turn instead of suspending
on a hook mid-turn. State lives in sqlite, as with the rest of the
conversation (0010: "our database owns the conversation"); there are no
long-lived suspended turns.

- **`thread_policies`**, one row per policied conversation: a snapshot of
  the policy definition (frozen at attach, as runs freeze machines), the
  `phase` (`working` / `waiting:<checkpoint>` / `done` / `parked`),
  checkpoints passed, a nudge counter, `parent_conversation_id`.
- **`checkpoint({id, summary})`**, a tool present only in policied
  threads:
  1. It validates the checkpoint's requirements and returns
     value-shaped errors so the model can fix them (for example: "pr
     needs a proposal: call propose_pr first").
  2. It runs the checks in the sandbox and records the results.
  3. It sets `waiting:<id>` and tells the model to stop.

  The turn ends; the card goes to `/inbox` (the existing machine-gate card
  data: summary, proposal, evidence, check results) and appears inline in
  the transcript.
- **Answering** goes through `POST /api/threads/<id>/checkpoint` with
  `{decision: approve|revise|reject, comment?}`:
  - **approve** runs the checkpoint's action first, deterministically
    (publish; the proposal is immutable between card and push). It
    then starts a turn through `startChatTurn` whose message is a
    `runEvent` chip, such as "plan approved" or "published: <url>".
  - **revise** starts a turn with Chad's comment in the **same thread**.
    This is the bug fix.
  - **reject** marks the thread `done` and resolves the proposal
    rejected (fixing open item 4, dangling `pr_proposals`).
- **Typing in a waiting thread** counts as *revise* with that text. A
  conversation reply is the natural way to send work back. Approve and
  reject stay explicit buttons.
- **Autonomy between checkpoints.** When a turn ends while the phase is
  `working`, no checkpoint was called, and no child is live, the runtime
  sends a continuation wake: "[policy] you're between checkpoints;
  continue, call `checkpoint`, or ask_chad". Three nudges with no
  progress (no tool calls besides reads) park the thread as needs-you.
  A live harness call or review blocks the nudge, because its wake
  resumes the thread.
- **Turn budget.** Policied turns get `MAX_STEPS` 400 (harness parity)
  instead of a plain chat's 50. A turn that exceeds it is handled by the
  nudge rule above, not by a crash.
- **Fresh branches.** A `review` requirement on a checkpoint makes the
  runtime start a child thread with the Review policy:
  - fresh conversation, *attached* to the parent's sandbox (0013, same
    checkout);
  - its brief is generated from raw material only: the ticket, `git diff`,
    evidence URLs, the proposal;
  - the parent's checkpoint call returns "review started"; the review's
    wake brings findings back; the parent addresses them and calls the
    checkpoint again.

  Whether a review must have passed is recorded on the card; Chad
  decides whether it blocks.
- **Evidence** is read from the thread's own `messages` tool results
  (`attach_screenshot`), plus any harness calls in that conversation.
  One `collectThreadEvidence(conversationId)` replaces
  `collectRunEvidence`; this closes open item 1 for every surface.
- **Observability comes free.** A policied thread is a chat turn, so it
  streams live with steps visible. No agent-stage blind spot (open item
  3).

## Starting and switching

- **Composer.** The target picker becomes a policy chip: none / Ship /
  Ticket / Review. Choosing one creates the conversation with the policy
  attached. `?policy=<id>` preselects it, as `?machine=` does now.
- **Mid-thread.** `attach_policy({policyId})` is an agent tool for when
  Chad says "ship it". It needs no approval: attaching only adds
  constraints. A "Ship this" action in the thread header does the same.
  **Detaching** removes guarantees, so it is Chad-only (a UI action).
  An agent cannot unpolicy itself.
- **Children.** `start_thread({policyId, prompt, fresh?})` replaces
  `start_machine`: a child thread with a policy, attached to this
  thread's sandbox by default. Same wake semantics; still linear (the
  roadmap's "an agent that wants several starts several").
- **Policies are policy.** Creating or editing one is approval-gated, as
  machines are now (0034). Each is a small zod definition: checkpoints
  (id, title, requirements, checks, action, review?), instructions, an
  optional route. The machine editor shrinks to this; the canvas is
  unnecessary for a linear list.

## UI

- The thread header gets a **rail** showing the policy's checkpoints and
  the current phase, so the thread view absorbs the run view's progress
  overlay. A waiting thread's checkpoint card renders inline in the
  transcript and in `/inbox`.
- Sidebar: policied threads are ordinary chats with the existing dots
  (amber for a waiting checkpoint). `kind = 'run'` stops being created.
- `/r/<runId>` and the machine graph stay for **historical** runs only
  (read-only) until they are purged.

## Phases (each testable on its own)

1. **Policy core + Ship.** `thread_policies`, the `checkpoint` tool, the
   answer route with publish-on-approve, the continuation nudge, the
   400-step budget, `collectThreadEvidence`, the inbox and transcript
   checkpoint card, and the composer chip with Ship only.
   **Experiment:** WYC-1589 run 5 on Ship versus run 4 on `flow`, then
   one *revise* loop on purpose (the case flow fails).
2. **Ticket.** The `plan` checkpoint, checks (the test command run by the
   runtime), and evidence requirements.
3. **Fresh branches.** Review as a child thread; Ticket's review before
   `pr`; the Review policy usable on its own.
4. **Unification surfaces.** `attach_policy`, the "Ship this" header
   action, Chad-only detach, `start_thread`, the rail, and the policy
   editor replacing the machine editor.
5. **Retire machines.** Remove `start_machine`, stage kinds, the
   `runMachine` interpreter, seeds, and `edit.ts`/`layout.ts`/graph,
   keeping a read-only history view. Done only after the big-ticket
   comparison below.

**The deciding experiment** (between phases 3 and 5): a genuinely big
ticket, run on Ticket-policy versus the old `ticket` machine, logged in
TRIAL-RUNS with the same metrics. The open risk is **context size**: a
long thread may exhaust the window. If it does, the answer is
compaction at checkpoints (the thread summarizes itself into the
checkpoint card, which Chad can read and correct). Going back to
amnesiac stages is not the answer.

## Costs and non-goals

- **Harnesses become tools, not stages.** The thread runs on a chat
  route; claude/pi only work as subagents. "claude *is* the implement
  stage" goes away, because claude has no conversation the thread can
  continue. Run 4 suggests this is the better shape anyway.
- Switching models mid-thread is less clean than per-stage routes:
  reasoning traces do not always carry across providers. A policy may
  pin one route for the whole thread.
- No parallel checkpoints, no branching graphs, no new stage kinds.
  Compaction is not designed here; the experiment decides whether it is
  needed.

## Open questions for Chad

1. **Checkpoint ends the turn** (recommended: sqlite owns state, no
   long-suspended turns, a reply is a revise) versus a mid-turn hook
   suspend like `ask_chad`.
2. **Typing at a waiting checkpoint counts as revise.** Is that right, or
   should typed text be a side conversation that leaves the checkpoint
   open?
3. **Does phase 5 delete the machine runtime outright** (recommended,
   per "prefer deleting"), or should harness-stage machines stay for any
   workload?
4. **Naming.** "Policy", "playbook", or "mode" in the UI.
