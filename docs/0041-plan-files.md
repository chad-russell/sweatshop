# 0041 — Plan files: an async, many-round plan review, and a visible phase

> **Superseded by [0064](0064-outline.md)** — the outline replaced this mechanism (removed in 0064 PR 3).

Status: **approved (PR #88, 2026-10-13); implemented on
`feat/0041-plan-files`.** Implementation notes at the end.

## Why

The `ticket` skill's planning phase is one call: `ask_chad`
(kind=approval) with a plan squeezed into a 2,000-character string. It
blocks the turn, and 0037's revise rule means anything Chad types resolves
it as DENIED, with the text as the comment. Feedback is therefore **one
round and one paragraph**. To discuss a plan, Chad has to reject it, wait
for a revision, and reject it again. The plan has no home either: it
exists only as a tool argument, so nothing later (the review, the PR card,
the thread header) can point at it.

Other coding agents (opencode, Cursor, plannotator) treat a plan as a file
the agent edits like any other, and you talk about it until you accept it.
This doc does the same with the smallest number of new mechanisms.

## Decisions (Chad, 2026-10-11)

- **The plan is a plain file**, `PLAN.md` in the conversation's work
  root (`/work/<conversationId>/PLAN.md`). It sits beside the repo
  checkouts, never inside one, so it is scratch: git never sees it and it
  never lands in a PR. The agent writes and edits it with `bash`, like any
  file. There is no plan table and no special edit tools.
- **No re-injection.** The plan is not put into every turn's context. The
  agent reads the file when it needs it, as it would a source file.
- **Plan review does not block.** Presenting a plan does not suspend the
  turn. Chad's messages while a plan is open are ordinary messages. There
  is no routing rule: the model decides whether a message is about the plan,
  something else, or both, and edits the file in response.
- **Approval is explicit.** The plan card's button, or the approval-gated
  `accept_plan` tool when Chad says so in chat, is the only thing that
  approves. The model infers
  what Chad means, but never infers permission.
- **Mockups are links**, not iframes. They are published URLs (the
  artifacts site, or an attachment) cited in the plan.
- `ask_chad` is unchanged. It stays the blocking primitive for questions
  that truly have to stop the turn.

## What changes

### `present_plan` (new tool, sandboxed chats)

`present_plan({ note? })` reads `PLAN.md` from the bound sandbox (a step,
through `openConversationSandbox`; ≤ 64 KiB, value-shaped `no-plan` /
`too-large` errors) and returns
`{ version, markdown, checklist: {done, total}, status }`.

- **The snapshot is the tool result.** It is stored in `messages` like
  every tool result. That gives versions (count the earlier `present_plan`
  results in the conversation), diffs (compare against the previous result)
  and durability (a stopped or reaped sandbox loses nothing the UI shows),
  all without a new table.
- **Before approval**, a call opens a review: it inserts a
  `pending_inputs` row of kind `plan`, with **no hook**. The row exists
  only so the Inbox shows "needs you". A newer `present_plan` supersedes
  the open row (resolved `{superseded: true}`), so only the latest version
  waits on Chad.
- **After approval**, a call is a progress snapshot. It opens no review
  and only updates the checklist the header shows. If scope changes
  materially, the agent passes `reapprove: true` to open a new review.
- The tool returns immediately. The agent keeps working: reading code,
  prototyping on a scratch branch, answering Chad. The skill says what it
  may not do before approval (step 1 below).

### Approve = a wake

The plan card has **Approve** (with an optional note) as its only action.
Approve does three things:
1. resolves the `plan` row;
2. wakes the conversation through `wakeConversation` (0022), the same path
   harness calls and child threads use: queued as steer mid-turn, a new
   turn if idle;
3. carries a new `RunEventMeta` kind, `plan`, with the version and note,
   rendered as a transcript chip ("Chad approved plan v3: …"), never as
   Chad's own words.

Approving an older version than the latest is refused (409, "v4 is
current"). `answerPendingWithText` skips `plan` rows: typing never resolves
a plan. That keeps 0037's revise rule intact for blocking asks while
removing it from plans.

### The plan card

The transcript and the Inbox render `present_plan` results as a document
card: the markdown (streamdown, already a dependency), a version badge, a
"changes since vN" toggle showing a line diff against the previous
snapshot, the checklist count, and Approve while the review is open. Older
versions collapse to a one-line chip.

**Quote to reply.** Selecting text in the card and choosing *Quote* puts
`> <selection>` into the composer. That is the whole annotation feature:
pointed feedback goes in an ordinary message the model reads, with no
separate annotation channel.

### The phase, visible

The thread header shows a phase chip, derived and never stored
(`lib/plan.ts`, pure, tested):

| derived from | chip |
| --- | --- |
| no `present_plan` yet | — |
| open `plan` row | **Plan v3 · needs you** (amber) |
| approved, checklist m/n | **Building 2/5** |
| pending `create_pr` input | **PR · needs you** |
| PR opened | **PR open** (link) |

The checklist is plain markdown (`- [ ]` / `- [x]`) in `PLAN.md`. The agent
ticks a box by editing the file, then calls `present_plan` when progress is
worth showing. The header never polls the sandbox. The Inbox plan card
shows the same chip.

### Skills

- `ticket` step 1: write `PLAN.md` (branch, changes by area, verification,
  non-goals, mockup links, a checklist of build steps), then call
  `present_plan` and **discuss**. Answer Chad's messages, edit the file, and
  re-present. Each new version says which of his points it addressed or
  declined, and why. Before approval: read, explore and prototype on a
  scratch branch only; no commits on the work branch and no pushes. The
  approval wake starts step 2. During the build, tick the checklist and
  re-present at milestones.
- `review`: if `PLAN.md` exists in the shared work root, it is the agreed
  plan (the spec, not the parent's reasoning), and the reviewer checks the
  diff against it. Attached child threads already share the workDir, so the
  reviewer needs nothing extra to read it.

## Non-goals

- No plan table, no plan editing tools, and no context re-injection.
- No iframes or embedded mockups.
- No change to `ask_chad`. Batched multiple-choice questions and
  non-blocking `ask_chad` are separate ideas for a later doc, informed by
  how this one lives.
- Plain chats (no sandbox) get no `present_plan`. Ticket work always has
  a sandbox.
- No hard gate tying `create_pr` to an approved plan (see resolved questions).

## Implementation sketch

1. `lib/plan.ts`: checklist parse, the phase derivation, and a small line
   diff (LCS; plans are small). Hand-rolled: no diff dependency. Pure tests.
2. `lib/agent/tools/plan.ts` core + the `present_plan` step and tool
   definition next to the other sandbox tools (`workflows/chat/`),
   included only when the binding has a sandbox. Store tests for the
   `plan` row lifecycle (open, supersede, approve, stale-version refuse).
3. `RunEventMeta.kind` gains `plan`. `/api/x/input` handles
   `{toolCallId, approvePlan: true, note?}` by resolving the row and
   calling `wakeConversation`. `answerPendingWithText` skips `plan`.
   The mock LLM gets a `present_plan` script so the turn test asserts that
   the turn does NOT suspend.
4. Cards: `components/ai-elements/plan-card.tsx` (transcript + Inbox),
   Quote-to-composer, and the header phase chip.
5. Skill edits (`ticket`, `review`), an AGENTS.md bullet, the gate, then
   a real ticket run on the preview as evidence (TRIAL-RUNS).

## Resolved questions (Chad, 2026-10-12)

- **Diff:** hand-rolled LCS line diff in `lib/plan.ts` (~40 lines). No
  new dependency.
- **No hard gate:** `create_pr` does not refuse when a plan was never
  approved. The skill instructs approval, and every PR is already gated
  by Chad. Revisit only if runs show agents skipping it.
- **Approval by chat goes through `accept_plan`, which is itself
  approval-gated.** When Chad says "looks good, go" in the thread, the
  agent does not proceed on its reading. It calls `accept_plan({version})`,
  which suspends on the `ask_chad` hook with the plan version on the card
  (the one mechanism every gated tool uses, 0034 A). Approving that card
  resolves the open `plan` row exactly as the plan card's button does, and
  the tool returns approved; a deny returns the comment and the review stays
  open. Since `accept_plan` is a blocking ask, typing while it waits
  answers it as a deny, per 0037's rule. So approval is always one explicit
  click, from either place, and the phase chip moves only on that click.
  Implementation: step 3 adds `accept_plan` beside `present_plan`, sharing
  the resolve-plan path with `/api/x/input`; a mock-LLM test covers
  approve → row resolved and deny → row still open.

## Implementation notes (2026-10-13)

- The PlanCard type and the pure derivations live in `lib/plan.ts`
  (client-safe); the review rows in `db/plans.ts`; the cores in
  `lib/agent/tools/plan.ts`; the tool definitions in
  `workflows/chat/plan-tools.ts` (spread in with the other sandbox
  tools); the card, Quote and phase chip in `components/plan-card.tsx`;
  the Inbox card in `components/inbox/plan-card.tsx`.
- The card's Approve answers a suspended `accept_plan` directly (resume +
  resolve) rather than waking — the turn is already waiting on it, so a
  wake would deliver the approval twice.
- A wake that lands mid-turn is queued as a steer, whose row carries no
  `runEvent` metadata; the transcript also recognizes the approval by its
  rendered text (`[plan vN approved]`), pinned by a test against
  `renderWake`.
- An open review keeps the page's wake watch on (as background children
  do), so an approval from the Inbox streams into an open thread.
