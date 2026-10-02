# 0011 — Sandbox visibility: per-call attribution

Status: **proposed** — awaiting Chad's approval before implementation.

## Goal

Make sandboxes a visible, first-class part of the app: for any chat you
can see which messages/calls ran inside a sandbox (and which one), and
for any sandbox you can see which chats and calls used it — including
after the sandbox is gone.

## Why

Sandboxes are fundamental, but today they are invisible after the fact.
Reading the code (2026-10-02) established:

- **A chat is not all-or-nothing.** Each sandboxed tool call (`bash`,
  `pi`, `claude`) resolves its sandbox *when it runs*, from the
  conversation's `sandbox_pref` column (`acquireConversationSandbox`).
  `none` removes the sandboxed tools at turn start. The composer can
  change the pref between turns, so one chat can run with no sandbox,
  then its own, then another owner's. Within one pref, `bash`, `pi` and
  `claude` share one sandbox.
- **Nothing records which sandbox a call used.** `messages` rows, tool
  results and `harness_runs` carry no sandbox id, and `destroySandbox`
  *deletes* the `sandboxes` row (0010 specified a `destroyed` status;
  the code never implemented it). "Which calls ran where" is
  unanswerable now and erased forever once a sandbox is destroyed.
- **`attach_sandbox` does not take effect.** It writes a
  `sandbox_attachments` row but never changes `sandbox_pref`, so the
  next `bash` call still lands in the chat's own sandbox.
- **Plain chats are offered tools that cannot work.** `buildChatTools`
  offers `bash`/`pi`/`claude` unless the pref is `none`, but `runBash`
  throws without a project. 0010's default table says plain chats get
  no sandboxed tools.
- **The picker's attach list never loaded** (fixed 2026-10-02: it now
  refreshes when the menu opens). Its entries are still opaque owner
  ids.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Granularity | Attribution is **per tool call**, not per chat. A chat's sandbox *state* (none / own / attached) is derived from calls plus the current pref. | A chat genuinely mixes states; per-chat metadata would lie. |
| What is recorded | The sandbox the call **actually ran in**, written when the call acquires it — not the pref at send time. | Prefs change; acquisition is the ground truth. |
| Storage | New table `sandbox_calls`, keyed by the AI SDK `toolCallId`. Not stuffed into message JSON. | Queryable both ways (chat → calls, sandbox → calls) and survives message edits/compaction. |
| History | Leases are **soft-destroyed**: `status = "destroyed"` + `destroyed_at`; rows stay. `sandboxes_owner_idx` becomes a partial unique index over non-destroyed rows so an owner can get a fresh sandbox later. | Calls keep pointing at something; implements what 0010 specified. |
| Existing history | Not backfilled. Calls before this ships show no sandbox chip. | The data was never recorded; guessing would be fabrication. |
| `attach_sandbox` | A successful attach **sets `sandbox_pref = attached:<id>`** for the conversation. Changing back is the composer picker. | Makes the tool mean what its description says, and makes the header truthful. |
| Plain chats | Sandboxed tools (`bash`, `pi`, `claude`, `create_pr`) are offered only when the conversation has a project (or an `attached:` pref). | Matches 0010 defaults; removes a tool that can only error. |
| Mixed-state chats | Supported. The UI shows state per call and flags a change between consecutive calls. | Locking the pref after first use would be simpler but removes the ability to switch mid-chat. |

## Schema (one migration)

```
sandbox_calls
  tool_call_id    text primary key      -- AI SDK toolCallId
  sandbox_id      text not null -> sandboxes.id
  conversation_id text not null -> conversations.id
  tool            text not null         -- bash | pi | claude
  via             text not null         -- dedicated | attached
  workdir         text not null         -- /work/<conversationId>
  at              integer not null      -- unix ms
  index (sandbox_id), index (conversation_id)

sandboxes
  + destroyed_at  integer null
  status now: creating | running | stopped | destroyed
```

`deleteLease` stays only for the failed-create path (a lease that never
got a ref). `destroySandbox` marks `destroyed` instead of deleting;
`getLeaseByOwner` and the attach list ignore destroyed rows.

## Phases

Each phase ships working and is committed on its own.

1. **Attribution (data only).**
   - Migration above; `db/sandboxes.ts` gains `recordSandboxCall`,
     `listCallsForConversation`, `listCallsForSandbox`, and soft-destroy.
   - `buildChatTools` threads `toolCallId` (from `execute`'s second
     argument) into `bashStep` / `harnessToolStep`; both write a row
     right after `acquireConversationSandbox` returns.
   - `attach_sandbox` sets the pref; plain-chat gating in
     `buildChatTools`.
   - Tests: mock-provider cases for dedicated, attached, pref change
     mid-chat, destroyed-sandbox history, and `attach_sandbox` →
     next `bash` landing in the attached sandbox.
2. **Chat surfaces.**
   - Server loads `toolCallId → {sandboxId, via}` for the conversation
     (the `/c/[id]` page passes it down; the client refetches when a
     turn ends).
   - A sandbox chip on each `bash`/`pi`/`claude` tool card (mono sandbox
     id, links to the sandbox page; a distinct style when the sandbox
     differs from the previous call's).
   - A header crumb/status in `AppHeader` showing the *current* state:
     none / own / attached to X.
3. **`/sandboxes`.**
   - List: sandbox, owner (chat title or machine run), project, status,
     last used, call count; destroyed ones shown dimmed.
   - Detail: attached chats, timeline of calls with links back to each
     chat and message. Sidebar entry beside Inbox/Machines.
4. **Picker.** Attach entries labelled by owner chat title / run name,
   project, status and last use, plus one line on what attaching means
   (own `/work/<chat>`, shared ports and processes).

## Out of scope

Stop/destroy/reap controls in the UI, per-sandbox terminals, resource
metrics, and the idle-stop reaper from 0010 (unchanged). Revisit once
the pages exist and show what is actually needed.

## Open questions

1. `create_pr` runs git against the sandbox too — attribute it as a
   fourth tool, or leave it out since it is not a user-visible
   sandboxed command? (Proposal: include it.)
2. Machine-run stages: calls inside runs already share one sandbox
   owned by the run. Record per-stage calls in `sandbox_calls` too, or
   only show the run's sandbox on `/r/<runId>`? (Proposal: the latter
   for now.)
