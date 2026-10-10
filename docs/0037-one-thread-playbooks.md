# 0037 — One thread, playbooks, gated tools: retire machines

Status: **draft 2026-10-10, rewritten the same day after a design
conversation with Chad.** The first draft proposed "threads with
policies" (a policy table, a checkpoint tool, a phase state machine).
Chad asked how that differed from one thread that delegates to
subthreads, guided by a skill, pausing at approval-gated tools. Mostly
it didn't. This version is that simpler design. Evidence: TRIAL-RUNS
runs 1–4 (WYC-1589).

## Decisions (Chad, 2026-10-10)

- **Machines are deleted outright** (phase 5 below). They are not kept
  for any workload.
- The UI word is **playbook**.
- **Typing while an approval is pending is a revise.** The text resolves
  the approval as denied, with the text as the comment, in the same
  thread.
- A "checkpoint ends the turn" design was chosen for the policy draft.
  That design is gone. Gates stay **mid-turn hook suspends**, like
  `ask_chad`/`create_pr` today. They are durable, and the revise rule
  above gives the same reply-to-revise feel.

## Why

Four runs of the same ticket split cleanly:

- **The substrate held.** Durable workflows, approval gates, the
  sandbox/preview bindings, and `attach_screenshot` evidence all worked.
  Run 4 used all of them.
- **Amnesiac stages were the cost.** Every staged failure (runs 2–3) was a
  stage re-deriving what an earlier stage knew. Measured from the DB:
  - the implement stages produced 170–255 KB of harness events;
  - verify's brief cut that to a 1–2 KB outcome, plus the checkout;
  - verify then spent 400–600 KB rebuilding it and never finished.

  Run 4's single `flow` stage kept its 173 KB thread and finished in 9½
  minutes with the best fix of the four runs.

The fix is not better briefs. It is to stop splitting one piece of work
across conversations. `flow` still splits on revise: "request changes"
starts a fresh visit that gets only the brief and the comment.

A chat already has run 4's properties:
- one context;
- background pi/claude calls that wake it (0022);
- approval suspends that pause the turn at natural points (`ask_chad`,
  `create_pr`);
- a live stream;
- revise in the same context: a denied approval returns its comment
  into the same turn.

What machines added beyond that is either already available to chats
(gates) or is the cause of the failures (stage splits).

**Where the gates sit.** Apart from plan approval, every pause guards
an *irreversible action*: a write that leaves the sandbox. In the
software factory that is a push or a PR; for homelab projects it will
be a deploy. "Gate the irreversible tool" is therefore the general
rule, and gated tools already exist. Plan approval is `ask_chad`.

## The model

**A thread is a chat. A playbook is a skill. Gates are tools.**

1. **Playbooks** are markdown runbooks ("how to ship a ticket here"):
   the steps, when to delegate, what evidence to attach, when to ask.
   They are advice, not enforcement.
2. **Gated tools** are the enforcement. An irreversible action happens
   only through a tool that suspends for Chad. The *card*, built by the
   runtime and not the model, carries the evidence he decides on.
3. **Fresh threads** are for deliberately independent context (review),
   started as a child chat that wakes the parent.

The one thing lost compared with machines is **forcing** a plan pause:
a playbook can ask for one, but the model could skip it. Enforcement is
added back only if the trial shows the model skipping it.

## What gets built

### 1. Playbooks (the skills slice of roadmap 2.3)

Playbooks are markdown files with front-matter (`name`, `description`,
optional `route`). They live in `docs/agent/playbooks/` for now and fold
into 2.3's `skills/` when that lands.

Loading:
- **Explicit:** the composer's target picker becomes a playbook chip
  (none / Ship / Ticket / Review; `?playbook=<id>` preselects). The
  chosen playbook's body is injected into the first send as a metadata
  note, the same way the `[viewing]` note is (0015): it is model input
  and a transcript chip, never Chad's words.
- **On demand:** a `playbook(name)` tool (like `system_docs`) loads one
  mid-thread. "Ship this" in a debugging chat = load Ship.

Catalog at go-live:

| Playbook | Shape |
| --- | --- |
| **Ship** | plan briefly → implement (delegate non-trivial edits) → tests → preview + before/after screenshots for visual work → `create_pr` |
| **Ticket** | as Ship, plus `ask_chad` plan approval first and a fresh review before `create_pr` |
| **Review** | fresh eyes: read the ticket, diff and evidence; report findings; change nothing |

Content comes from `flow`'s instructions plus the trial's stop rules
(a blocked visual check is a finding; retry ≤ 2; never dig into app
internals).

### 2. Evidence on gated cards (deterministic, runtime-built)

When `create_pr` (and later `git_push`/deploy gates, 0034 B) builds its
approval card, the runtime itself:

- runs the project's **test command** in the sandbox and puts pass/fail
  plus the tail on the card;
- collects the thread's **screenshots**: `attach_screenshot` tool
  results from the conversation's `messages`, plus its harness calls'
  `harness_events`. One `collectThreadEvidence(conversationId)`
  replaces `collectRunEvidence`; this closes the agent-stage evidence
  gap;
- keeps the existing commits and diffstat.

The model cannot skip what the card shows. A missing test run or a
visual change with no screenshot is visible *before* Chad approves.

### 3. Typing while an approval is pending = revise

Today a send during a suspended turn queues as steer and never resolves
the hook, so the turn stays stuck. New rule in the chat send route:

- If the conversation has a pending `approval` row, the text resolves
  it as **denied with the text as the comment**.
- If the pending row is a `question`, the text is the answer.

Either way the same turn resumes with the text. The inbox and
transcript cards keep explicit Approve / Deny buttons.

### 4. Background-work budget

Plain chat turns cap at 50 model steps. Run 4's stage took 51, so a chat
would have stopped right at the finish.

- A turn that has a playbook loaded raises the cap to 400 (harness
  parity).
- At the cap, the runtime sends a continuation wake
  ("[budget] continue or ask_chad") instead of ending silently.
- Three consecutive budget wakes with no tool progress park the thread
  as needs-you.

### 5. `start_thread` (fresh child threads)

`start_thread({prompt, playbook?, fresh?})` starts a child chat:
- **attached** to this thread's sandbox by default (0013, same checkout),
  or `fresh: true` for its own sandbox;
- it records its parent and wakes it on settle, through the same wake
  primitive runs use today (0022);
- `cancel_run` covers it.

Review is its main use. The parent passes raw material (ticket, branch,
evidence URLs) in the prompt, never its reasoning. Still linear: the
roadmap's "an agent that wants several starts several".

### 6. Delete machines

This is the last phase, after the big-ticket comparison. It removes:
- `start_machine`;
- the `runMachine` interpreter, stage kinds, `agent-step`,
  `harness-step`;
- the machine tools and their approvals;
- `lib/machines/*` (definition, edit, layout, brief, evidence), the
  seeds, `/machines`, the graph, and the `@xyflow/react` dependency;
- `pr_proposals` and `publish` (chats publish through `create_pr`; the
  0034 credential split still applies).

Historical runs stay readable as conversations; `machine_runs` rows
are kept read-only until purged, with a minimal static `/r/<id>`. The
inbox's machine-gate card goes away.

## Daily use

- **Question or research:** a plain chat, unchanged.
- **Small fix:** a project chat with the Ship playbook. One touch: the
  `create_pr` card, with tests and screenshots on it.
- **Big ticket:** Ticket. Touches: plan approval, then the PR card with
  the review's findings in the thread.
- **Debugging that becomes a fix:** stay in the chat and say "ship it";
  the Ship playbook loads into the same context.
- **Review a branch or PR:** Review, or `start_thread` from any thread.
- **Morning:** `/inbox` lists pending approvals; answer from the card, or
  open the thread and type to revise.

## Phases (each testable on its own)

1. **Evidence on cards + typing-revises.** Items 2 and 3. Both are useful
   to today's chats immediately. *(Built 2026-10-10: `pending_inputs.card`
   holds the runtime evidence; the check is capped at 900 s and runs only
   in an already-bound sandbox. Typing answers the OLDEST pending input.
   A hook that will not resume falls back to a steer, so no message is
   lost.)*
2. **Playbooks + budget.** Items 1 and 4, Ship only. *(Built
   2026-10-10: `conversations.playbook`; the body goes into the turn
   instructions, not a note, because a mid-thread `use_playbook` must
   govern every later turn. Budget exhaustion continues the thread
   through a `budget` wake; the "three nudges with no progress"
   heuristic became "three consecutive continuations with no human
   message", which is simpler to count.)*
   **Experiment:** WYC-1589 run 5 in a project chat with the Ship
   playbook versus run 4 on `flow`, same metrics, plus one deliberate
   revise at the PR card (the case `flow` fails).
3. **`start_thread` + Ticket/Review.** Item 5 and the remaining
   playbooks.
4. **The deciding experiment.** A genuinely big ticket: Ticket playbook
   versus the old `ticket` machine, logged in TRIAL-RUNS. The open risk
   is **context size**. If a long thread exhausts the window, the answer
   is compaction (summarize at a gate, the summary shown on the card),
   not a return to amnesiac stages.
5. **Delete machines** (item 6).

## Costs and non-goals

- **Harnesses become tools, not stages.** The thread runs on a chat
  route; claude/pi only work as subagents. Run 4 suggests this is the
  better shape anyway.
- **Plan approval is advisory.** If the trial shows the model skipping
  it, the smallest fix is a gated `begin_work` tool. It is not a return
  to a policy engine.
- Switching models mid-thread is less clean than per-stage routes; a
  playbook may pin one route.
- No policy table, no checkpoint tool, no phase state machine, no
  playbook editor beyond editing markdown (2.3 brings agent editing with
  a commit).
