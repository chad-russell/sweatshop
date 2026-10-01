# 0010 — Drop eve: AI SDK + Workflow SDK runtime, explicit sandboxes

Status: **approved (2026-10-01)** — direction agreed in chat, doc
approved as written; both open questions resolved at the end. Phase 1
spike remains the go/no-go gate before anything is torn up.

## Goal

Replace the eve agent runtime with plain AI SDK (`WorkflowAgent`) on the
Workflow SDK we already run inside Next, make sqlite the source of truth
for conversations, and introduce **sandboxes** as an explicit,
provider-agnostic resource that chats and machine runs acquire on demand.

## Why

eve does real work in exactly one place — the durable chat session
(turns, steer, cancel, compaction, reconnect, human input). Everywhere
else its ownership model has cost us:

- **Second process.** The eve runtime is separate from Next, so
  `transition`, the turn-end nudge and `start_machine` round-trip over
  HTTP (`SWEATSHOP_APP_ORIGIN`), sqlite doubles as an IPC channel, and
  code outside `agent/` needs a `./dev` restart.
- **Mirrored conversations.** `conversation_events` duplicates eve's
  stream for search, titles and inbox, governed by the 0002 dual-write
  invariants.
- **eve owns sandboxes.** eve stages could not share a run's sandbox
  (0009 amendment); the claude tool finds its own sandbox via a marker
  file + scan; the harness cache must detect a replaced sandbox. We
  already have our own provisioning (`lib/sandboxes/`).
- **Data in through side doors.** Project, model and machine-visit
  binding each ride a request header → principal attribute; dynamic
  tools have closure-capture rules; debugging meant reading minified eve.

Sweatshop is single-user, self-hosted and harness-heavy; eve's
distinctive strengths (managed Vercel deploy, channels, built-in sandbox
providers, evals) go unused. Twelve files import eve; harness, machine,
sandbox and git-host code is already plain AI SDK.

## Principle: explicit options at the SDK layer, knobs above

Every behavior is an explicit, typed option in our own code (which
sandbox, which model, attach vs dedicated). Defaults and heuristics are
layered on top, and the UI exposes them as knobs — e.g. the composer
gains a **sandbox dropdown** beside the model dropdown ("none / new
dedicated / attach to running sandbox X"). Nothing is decided implicitly
by a framework.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Agent runtime | `WorkflowAgent` from `@ai-sdk/workflow`, in-process in Next. | One process; machines already run here. |
| Durability grain | **One workflow run per turn.** The run loads history from sqlite, streams, persists the result, ends. | Resume + reconnect per turn via `WorkflowChatTransport`; avoids the unbounded raw-stream replay a whole-session run has (vendored `ChatSessionModeling.md` callout); new code applies next turn. |
| Source of truth | sqlite. `messages` stores full `UIMessage`s (parts, tool calls, metadata). `conversation_events` mirror and the 0002 dual-write rules retire. | One copy; search/titles/inbox read our tables directly. |
| Cancel | Cancel the turn's workflow run. | Native to the Workflow SDK. |
| Steer | Queue the message in sqlite; `prepareStep` drains the queue into the next model step. A message arriving with no active turn starts a new turn. | Keeps the eve behavior Chad uses, without a long-lived run. |
| Human input | Tool approvals and questions are `defineHook` waits inside the turn run (same mechanism as machine human gates). Pending requests are rows we write, not derived from mirrored events. | One mechanism for all "waiting on Chad". |
| Compaction | Ours, at turn start: if history exceeds the model's budget (`lib/model` context window), GLM-Flash summarizes older turns into a stored summary; the model sees summary + recent turns. UI history is untouched. | Simple, inspectable; eve's was opaque. |
| Conversation binding | `conversations.project_id`, `model_id`, `sandbox_id` are plain columns. | Replaces header → principal-attribute plumbing. |
| Channels | Dropped. Vercel Chat SDK if ever needed. | Unused. |
| Auth | Unchanged posture (LAN-only, no auth). **Hard rule kept:** a real verifier before any internet exposure. | `channels/eve.ts` goes away; the rule doesn't. |

## Sandboxes

Terminology: **sandbox**, never "container" — podman containers are
today's only implementation; a VM provider is the intended direction.

### Provider seam

```ts
interface SandboxProvider {
  readonly kind: string;                       // "podman" today
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  attach(ref: string): SandboxHandle;          // stateless re-attach
  stop(ref: string): Promise<void>;            // preserve state
  resume(ref: string): Promise<void>;
  destroy(ref: string): Promise<void>;
}
interface SandboxHandle {
  readonly ref: string;                        // provider-opaque id
  run(command, env?, cwd?): Promise<{ exitCode; stdout; stderr }>;
  spawn: Experimental_SandboxSession["spawn"]; // bridge harnesses
}
```

`lib/sandboxes/provision.ts` becomes the podman provider. Nothing above
the seam (tools, harnesses, machines, UI) knows the provider kind.

### Leases

A `sandboxes` table: `id, provider, ref, owner_kind (conversation |
machine_run), owner_id, project_id, status (creating | running |
stopped | destroyed), last_used_at, created_at`. Plus
`sandbox_attachments (sandbox_id, conversation_id, workdir)`.

`acquireSandbox(request)` is the one entry point. Requests are explicit:

- `{ mode: "dedicated", owner }` — this owner's own sandbox, created on
  first acquire, reused after. Own ports, processes, network.
- `{ mode: "attach", sandboxId }` — join an existing sandbox; the
  attacher gets its own worktree at `/work/<conversationId>` but
  knowingly shares ports and processes.

Workdirs stay under `/work/<ownerId>`, never `/workspace` (0009: pi runs
in-process and treats a host-existing workdir as shared).

### Defaults (heuristics over the explicit layer)

| Caller | Default |
| --- | --- |
| Plain chat | No sandbox. Sandboxed tools are not offered. |
| Project chat | `dedicated`, **lazy** — created on the first sandboxed tool call (bash, pi, claude, create_pr). A talking-only project chat costs nothing. |
| Machine run | `dedicated`, created at run start (as today). |
| Attach | Only by explicit choice — composer dropdown, or an agent tool (`attach_sandbox`). Never automatic. |

### Lifecycle

Idle sandboxes **stop** (state preserved; resume on next acquire) after
a configurable idle window; **destroy** when the owner is deleted or
after a long idle window. `npm run sandbox:gc` grows into this reaper.
Deferred, not in scope: a warm pre-prepared pool per project, only if
first-use latency hurts.

### What this deletes

The claude tool's marker-file + scan, the harness cache's
replaced-sandbox eviction (handles are stable by `sandboxes.id`), and
the 0009 restriction that agent stages can't share a run's sandbox.

## Shape after

```
app/api/chat/route.ts               POST: start a turn run (or queue steer)
app/api/chat/[runId]/stream         GET: reconnect (WorkflowChatTransport)
app/api/chat/[runId]/cancel         POST
app/api/inputs/[hookToken]          POST: answer approval/question
workflows/chat/turn.ts              "use workflow" — one turn
workflows/chat/steps.ts             load history, persist, compact
lib/agent/                          instructions, tools, model resolution
lib/sandboxes/provider.ts           SandboxProvider seam + podman impl
lib/sandboxes/lease.ts              acquireSandbox, attach, reaper
components/chat.tsx                 useChat + WorkflowChatTransport
```

Gone: `agent/`, `withEve()`, `vendor/eve/`, `docs:eve`,
`agent/hooks/mirror.ts`, `db/mirror.ts`, `conversation_events`,
`lib/session-attributes.ts`, `SWEATSHOP_APP_ORIGIN`.

## Phases

Each phase is its own commit series; typecheck/lint/test green at every
commit.

1. **Spike (go/no-go).** One chat on the new runtime under `/x/`,
   beside eve, with a mock-LLM test plus one live check. Must prove:
   a full turn; reload mid-stream reconnects; cancel; steer drained by
   `prepareStep`; one approval hook inside the tool loop; two turns
   sharing history from sqlite. Mock LLM lands here (AGENTS.md rule).
2. **Sandbox provider + leases.** `SandboxProvider`, `sandboxes` /
   `sandbox_attachments`, `acquireSandbox`, reaper. Machine runs move
   onto it.
3. **Tools off `eve/tools`.** bash, pi, claude, create_pr,
   start_machine, transition as AI SDK `tool()`; `harness-tool.ts` on
   acquired sandboxes; `transition` / `start_machine` become direct
   calls, not HTTP.
4. **Chat cutover.** `chat.tsx` → `useChat`; model + sandbox dropdowns;
   inbox reads hook rows; titles fire from the persist step; search on
   `messages`. Migration script imports existing eve transcripts from
   `conversation_events` into `messages` (open question 1).
5. **Machine agent stages.** `eve` stage kind → `agent` stage
   (in-process `WorkflowAgent`), optionally on the run's sandbox. Turn-
   end nudge and visit header removed. Existing machine definitions
   migrate `eve` → `agent`.
6. **Delete eve.** Remove everything in "Gone"; rewrite AGENTS.md's
   premise ("an idiomatic AI SDK + Workflow SDK agent app") and
   architecture; drop the eve skill from `.agents/skills`.

## Given up

eve traces and evals (unused), channels, managed Vercel deployment,
eve's built-in sandbox providers.

## Risks (all exercised by Phase 1)

- `prepareStep` can read the steer queue mid-turn inside a workflow.
- A `defineHook` wait works inside a `WorkflowAgent` tool's execution.
- `WorkflowChatTransport` reconnect behaves on our local workflow world.

If any fails, we stop before anything is torn up.

## Phase 1 spike — proven (2026-10-01)

All four risks answered, mock-LLM tests green in the normal gate
(`tests/x-chat.test.ts`, real workflow runs under vitest) and verified
live against GLM on `/x`:

- **Full turn + history sharing** — a turn persists to `messages`
  (model_message JSON + search text), and the next turn loads the full
  conversation from sqlite.
- **Approval hook in the tool loop** — a tool creates a `defineHook`
  with the toolCallId as token; the turn suspends (durably) and resumes
  on the answer. Verified live: the real model called `ask_chad`, the
  stream replayed the tool part on reconnect, and `/api/x/input`
  resumed the turn to completion.
- **Steer** — queued messages are drained **between model slices** and
  injected as user messages (persisted). If the turn has no further
  slice, the row folds into the next turn's history — nothing is lost.
- **Cancel** — `run.cancel()`; nothing from the turn persists.

Findings that changed the implementation (kept here as the record):

1. **prepareStep cannot steer.** It runs in the agent's context; a step
   call from that nested closure never dispatches. The turn instead
   runs **one model step per slice** (`stopWhen: isStepCount(1)`) and
   drains the steer queue in the workflow body between slices — where
   calling steps is legal.
2. **The model instance crosses a step boundary** (`doStreamStep`
   records its arguments) and must be workflow-serializable; raw
   provider instances (zhipu v3, `MockLanguageModelV4`) are not.
   `SerializableChatModel` (workflows/chat/model.ts) carries only the
   recipe and rebuilds on deserialize (@workflow/serde class protocol).
   Verified live with zhipu.
3. **Workflow code may not touch Node APIs outside `"use step"`** — the
   SDK's esbuild guard rejects it at build time (it caught our first
   steer design). All sqlite access lives in steps.
4. **Vitest runs real workflow runs** via a loopback executor
   (`tests/helpers/workflow-executor.ts`): the SDK's own dev/workbench
   pattern — prebuild the flow bundle with `@workflow/builders`, serve
   its POST handler on an ephemeral port, point
   `WORKFLOW_LOCAL_BASE_URL` at it. Adds `@workflow/builders` as an
   exact-pinned devDependency.
5. **Client import**: `WorkflowChatTransport` must come from
   `@ai-sdk/workflow/client`; the main entry pulls server-only modules
   into the browser bundle.
6. Tool-result text extraction round-trips through `messages.text`
   (searchable).

## Resolved questions (approval, 2026-10-01)

1. **Transcript import: best-effort only if it falls out trivially.**
   Chad: everything so far is simple test conversations — if porting is
   super easy, do it; otherwise skip. Everything gets re-tested on the
   new runtime anyway. No design effort to be spent here.
2. **Idle windows approved:** stop after 30 min idle, destroy after
   14 days idle. Tunable later.
