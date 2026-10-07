# 0022 — Async runs and harness calls with auto-wake

Status: **implemented 2026-10-08** (both cuts, branch glen/0022-async-runs).
Approved the same day by Chad, with the three defaults kept. Roadmap
item 1.3 (the floor's biggest unknown).

## Implementation notes (delivered)

- The wake primitive is `lib/chat/wake.ts` (`wakeConversation`,
  `wakeRunIfDue`, `wakeCallIfDue`, `sweepWakes`); the steer-or-start
  branch mirrors the chat route's own send logic, with an in-process
  per-conversation lock so two settling children cannot start two turns.
- Wake messages are user rows carrying `metadata.runEvent`
  (`{ kind, id, status }`), rendered as a transcript chip
  (`RunEventChip`, chat-session) — the text is the model input.
- Settle triggers live in the run's own steps (`markRun`,
  `beginVisit`'s human-gate `waiting`); pre-start failures do not wake
  (the calling tool throws into the live turn). `startRun`'s early
  failure path is excluded by requiring `workflow_run_id` in the sweep.
- Idempotency: `woken_settled_at` stamped AFTER delivery; duplicates
  over losses. The sweep rides a new 30 s timer in
  `instrumentation-node.ts` (`WAKE_SWEEP=off`), first pass 10 s after
  boot.
- `machine_runs.parent_conversation_id` FK is `ON DELETE SET NULL`
  (hand-added to migration 0039 — drizzle omits the clause in
  `ADD COLUMN` statements; the snapshot records it correctly).
- `harness_calls` (migration 0040): `hc_…` rows; settles are
  running-only writes so a racing cancel wins exactly like
  `markRunCancelled`. `recordHarnessRunEnd` gained a `cancelled`
  status. The starter core is `lib/chat/harness-call-start.ts` (the
  step wraps it; a `start` seam keeps tests off the runtime); the
  worker is `workflows/chat/harness-call.ts` (one
  `harnessAdvanceStep` per semantic step — the old chat loop moved
  verbatim into per-step shape; `harnessSettleStep` saves the resume
  handle, settles, releases the slot, wakes).
- `harnessToolStep` narrowed to its one remaining caller: agent stages
  (inherited binding, synchronous — a run's stage is already async
  from every chat). The chat's own conversation-binding branch is gone.
- `inspect` reads `hc_…` ids; `cancel_run` handles `mr_…` and `hc_…`;
  the pi/claude tool descriptions and the `HarnessCard` ("in
  background" pill + handle, live line off — the session page is the
  live view) teach the new shape.
- Tests: `tests/wake.test.ts` (routing, settle matrix, idempotency,
  sweep containment, cancel) and `tests/harness-calls.test.ts` (store
  settle-once, starter seams incl. busy/start-failed cleanup, wake,
  cancel, trashed parents). 441 passing.

## Why

Go-live means Chad does daily work here. Today, long work comes in two
shapes and only one is truly async from the chat's point of view:

- **Machine runs** already return a handle immediately (`start_machine`
  calls `startRun` and answers with the run URL) — but nothing ever tells
  the parent conversation what happened. The agent fires a run and never
  hears back unless the human relays it.
- **Harness calls** (`pi` / `claude` chat tools) hold the chat turn for
  their entire duration: `harnessToolStep` is one `"use step"` looping
  `runHarnessAgentStep` until the harness turn ends. The thread that
  started the work cannot do anything else until it finishes.

Chad's framing (2026-10-08): the point is **async at all**, not instant
feedback. Fire a tool, keep talking, ask "how's it going", abort if
needed, and when the child finishes it arrives **as a final message in
the parent thread**. Design rule: simplest thing (YAGNI explicitly
invoked).

## Decisions

1. **The wake is a message, not an event system.** When a child settles,
   the parent conversation receives a synthetic user-role message
   ("[run finished] …") through the exact path a human send takes:
   mid-turn → steer queue (drained between slices), idle → a new turn.
   No websockets, no polling endpoint, no new inbox concept.
2. **No `wait` tool.** The wake *is* the wait. Explicit check-ins use the
   existing `inspect` tool (works on `mr_…` today).
3. **`start_machine` keeps its shape** — it already returns a handle.
   Cut 1 adds the wake-back, a `cancel_run` tool, and nothing else.
4. **Harness calls go always-async** (roadmap decision: "return a handle
   immediately"). No `background` flag, one code path. The live activity
   stream moves from the chat transcript to the existing `/h/<kind>/<id>`
   events page; if quick-pi iteration ever feels too heavy we can add a
   sync opt-in later — not now.
5. **Cancelled runs do not wake.** The canceller (the parent's own turn,
   or the human) already knows. Wakes fire on completed, failed,
   needs-attention, and waiting (a human gate needs input — the parent
   should be able to say "your Ticket run is waiting on you").
6. **Agent-stage harness calls are untouched.** They already run inside
   machine runs, which are already async from every chat.

## Cut 1 — machine runs (the wake)

**Parent link.** `machine_runs.parent_conversation_id` (nullable, →
conversations, `ON DELETE SET NULL`; set only by the `start_machine`
tool). Runs started from the UI, ⌘K, or the API have none and never wake
anything.

**Wake primitive.** `lib/chat/wake.ts`, one function:

```
wakeConversation(conversationId, event)
  activeRunId live → enqueueSteer(rendered text)
  else           → startChatTurn(conversationId, rendered text)
```

`startChatTurn` is already the server-started-turn path (0016 "Fix it"
chats). The wake text is short and self-contained:
`[run finished] <machine name>: <status>` + `/r/<id>` + the clipped
failure reason (failed/needs-attention) or the last visit's clipped
outcome (completed) — enough for the parent to react without an inspect
round-trip; depth stays in `inspect`.

**Message shape.** A user-role message persisted with
`metadata.kind = "run-event"` (`{ runId, status }`), rendered in the
transcript as a chip (same treatment as the 0015 viewing note) so it
never reads as Chad's own words. Steer-delivered wakes land as ordinary
steer user rows — acceptable; they read as system-ish text.

**Trigger.** Inside the run's own workflow, at the settle points: the
`markRun` step when it writes a settled status, and `beginVisit` when it
marks a run `waiting` at a human gate. `startRun`'s pre-workflow failure
marking (invalid overrides, could-not-start) does **not** wake — the
calling tool throws and the parent's live turn sees it directly.

**Durability.** `machine_runs.woken_settled_at`. The wake step starts
the turn/steer first, then stamps `woken_settled_at = settled_at`. A
crash between the two can duplicate a message; the reverse order could
lose one. Duplicates are the cheaper failure. Backstop: the 30 s
background tick (the one that reconciles previews) sweeps
`parent_conversation_id IS NOT NULL AND workflow_run_id IS NOT NULL AND
status IN (settled) AND settled_at > woken_settled_at` and re-wakes —
this also recovers wakes lost to a server restart.

**Concurrency.** Two children settling at once for one parent must not
start two chat turns (interleaved `persistTurn`). The wake module keeps
an in-process per-conversation chain; there is exactly one Next process
(0020). The tick sweep shares the same function, so the guard covers it.

**Cancel.** `cancel_run` tool (`runId`), wrapping the existing
`cancelRun` in `lib/machines/runs` — the UI already cancels from the run
view; this is the agent surface for it. Value-shaped errors (`not-found`
/ `not-live`).

**Sidebar / attention.** Nothing new: runs are conversations (0012) with
dots, and the wake message makes the parent unread on its own.

## Cut 2 — harness calls (pi/claude) async

**The tool step shrinks to a starter.** Validate route → claim the
one-per-session slot (`claimHarnessRun`, unchanged keying) → open the
sandbox → resolve `resumeFrom` → insert a `harness_calls` row →
`start(harnessCallWorkflow, …)` → return the handle
(`{ callId: "hc_…", eventsUrl }`). The turn never advances the harness
itself.

**The worker is a workflow.** `workflows/chat/harness-call.ts` — the
exact do/while from `harnessToolStep` (resolve route once, loop
`runHarnessAgentStep` to terminal, sink events into `harness_events`),
minus the chat-stream tee (its `getWritable` would tee into a stream
nobody reads). On terminal: save `resumeFrom` (natural completion only),
mark the call, release the slot, `wakeConversation` with
`[pi finished]` + clipped final text + `/h/<kind>/<conversationId>`.

**Entity.** Small table `harness_calls`:
`id hc_…, conversation_id, kind, task (clipped), status, workflow_run_id,
error, created_at, updated_at` + `woken_settled_at` for the same tick
sweep (one query, both tables). Not a conversation (0012 is a run
concept; harness activity already has its page). `inspect` learns
`hc_…` ids.

**Slot and reaper.** The claim keeps `harness_runs.status = running` for
the call's life, which (a) rejects a second call on the same
conversation with today's exact error, and (b) already puts the sandbox
in the reaper's busy set (`busySandboxIds` reads running harness runs)
— long calls don't get their sandbox stopped out from under them. No
reaper changes.

**Cancel.** `cancel_run` extended: `hc_…` cancels the workflow run,
marks the call and slot cancelled. A cancelled call saves no
`resumeFrom` — the next call resumes from the last naturally-completed
handle (or fresh).

**Trade-offs accepted.** The chat transcript no longer streams harness
activity live (the events page remains the live view). Each pi call now
costs one wake cycle before the parent sees the result — that is the
point, but it's the thing to watch in the trial week.

## Explicitly not doing (YAGNI)

- Fan-out, parallel stages, orchestration (roadmap decision — machines
  stay linear; an agent that wants several runs starts several).
- A `wait`/block tool, priorities, queues, retries, schedules.
- Backgrounding bash or preview tools (fast, or already async).
- New notification surfaces (tabs, toasts) — dots + the message itself.
- Changing how gates are answered (still `/inbox`); the wake only
  informs the parent.

## Tests

Scripted mock model (never a real call), per-worker temp dbs:

- Wake routing: live turn → steer row; idle → turn started, message
  carries `metadata.kind = "run-event"`.
- Settle matrix: completed / failed / needs-attention / waiting wake;
  cancelled and pre-start failures don't; pre-start failure still throws
  in the tool.
- Sweep idempotency: `woken_settled_at` blocks a second wake; a forced
  gap (unset stamp) recovers via the sweep.
- Parent deleted (`ON DELETE SET NULL`) → no wake, no crash.
- Harness call: starter returns without advancing; worker reaches
  terminal; wake fires; slot released; reaper busy while running.
- `cancel_run` on `mr_…` (live → cancelled; finished → `not-live`) and
  `hc_…`.

## Open questions (defaults chosen; veto any)

1. Wake on `waiting` gates — default yes. Suppress if noisy in practice.
2. Wake text includes clipped outcome/error — default yes (the parent
   shouldn't need an inspect to react).
3. Always-async pi with no sync escape hatch — default yes per roadmap;
   revisit only if the trial week complains.
