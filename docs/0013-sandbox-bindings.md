# 0013 — Sandbox bindings: chosen once, inherited recursively

Status: **shipped (2026-10-02)** — direction agreed in chat with Chad;
text approved by Chad 2026-10-02; phases 1–6 (plus 4b) implemented the
same day.

## Goal

A project defines how to make a sandbox. Every top-level chat or
workflow (machine run) in that project runs "inside" one sandbox: all
its tools — bash, pi, claude, agent stages, child machine runs — run in
that same sandbox, in the same working directory, recursively. For
coding harnesses it is *as if* the harness process runs in the sandbox
(claude really does, as an in-sandbox bridge; pi forwards every
bash/file call through the sandbox session — both are SDK-supported).

The sandbox choice is made **once, at the start**: a fresh sandbox, or
attach to an already-running one for that project. Children inherit it.
Nothing below the top level ever picks or changes a sandbox.

Use the SDK's own pattern for this rather than inventing one: the
workflow-harness docs keep only an id in workflow state and reattach the
live sandbox session inside each step. Our version of that id is the
**binding**.

## Why

Read against the code and installed packages (ai 7.0.122,
@ai-sdk/workflow 2.0.53, @ai-sdk/harness 1.0.132, harness-claude-code
1.0.136) on 2026-10-02:

- **The choice is re-resolved on every tool call.** `acquireConversationSandbox`
  reads `conversations.sandbox_pref` per call, and the composer can
  change it between turns (0011 documented this as intended). One chat
  can run in several sandboxes; "where did this run" needs 0011's
  per-call attribution to answer.
- **Children don't inherit.** `start_machine` from a chat creates a
  fresh dedicated sandbox per run. Machine agent stages get no sandbox
  tools at all — only `transition`.
- **Attach gives a different directory.** `acquireAttached` gives the
  attacher its own `/work/<conversationId>`, so attaching to inspect
  another agent's work shows an empty directory, not that work.
- **Run sandboxes die with the run.** `runMachine`'s `finally` calls
  `removeWorkspace` → `destroySandbox`, so a finished run cannot be
  inspected or attached to — the main reason to attach.
- **The project "factory" is unused.** `sandbox_configs.image_ref` and
  `network_policy` exist, but `createContainer` always runs
  `localhost/sweatshop-sandbox`.
- **Harnesses get the "basic" sandbox session.** `toSandboxSession`
  returns a plain `Experimental_SandboxSession`, which the harness docs
  call a fallback for projects that "cannot expose the full network
  session". So claude's bridge address is hand-wired
  (`connectContainerToHarnessNetwork` + `portEndpoint: ws://${bridgeIp}:4000`
  in `buildHarnessAgent`); harness-claude-code itself only demands an
  explicit `portEndpoint` when `getPortEndpoint` is missing.

## Decisions

### The binding

```ts
type SandboxBinding =
  | { kind: "none" }                                  // plain chat
  | { kind: "pending"; projectId: string }            // project chat, not yet created
  | { kind: "bound"; sandboxId: string; workDir: string; owner: boolean };
```

- Fixed when a top-level conversation or run starts. A project chat
  starts `pending` (sandboxes stay lazy — a talking-only chat costs
  nothing) and becomes `bound` on the first sandboxed call, exactly
  once. After that the binding never changes; switching sandboxes means
  starting a new chat.
- Stored on the top-level owner (replaces the per-call meaning of
  `sandbox_pref`; the composer chooses fresh/attach only on a fresh
  conversation, and shows the binding read-only after).
- Passed **explicitly** to every child — it is a small plain object, so
  it serializes through workflow state and step arguments unchanged.
  Every step that needs the sandbox turns it into a live session with
  one function (`openSandbox(binding)`), which resumes a stopped lease.
- `owner` says who controls lifecycle. Only the top-level owner's lease
  can be stopped/destroyed by the app; inherited and attached bindings
  never touch lifecycle.

### Inheritance

| Started from | Gets |
| --- | --- |
| Project chat (fresh) | its own sandbox, `/work/<conversationId>` |
| Project chat (attach) | **a copy of the target's binding** — same sandbox, same `workDir`, `owner: false` |
| `bash` / `pi` / `claude` in a chat | the chat's binding |
| `start_machine` from a chat | the chat's binding by default (`fresh: true` opts into a new sandbox) |
| Machine run started top-level | its own sandbox, `/work/<runId>` |
| Harness and agent stages in a run | the run's binding; agent stages gain `bash`/`pi`/`claude` |

Attach and inherit are the same operation — copy a binding. Creating a
new top-level chat or run is the only thing that creates a sandbox.

**Same directory by default, deliberately.** Too much isolation is the
bigger risk: a QA stage must see what the builder stage built, and
attaching is mostly for inspecting or following up on finished work.
Parallelism comes from starting separate chats/runs (each gets its own
sandbox). An agent that fans out inside one context accepts the
occasional collision or arranges its own isolation. Harness-native
subagents are not relied on; sweatshop-level fan-out (chats, runs,
harness calls) is the parallelism model.

### Network sandbox session (harnesses)

`toNetworkSandboxSession(handle, binding)` returns a full
`HarnessV1NetworkSandboxSession`:

| Member | Implementation |
| --- | --- |
| `id` | the lease's `sandboxes.id` |
| `defaultWorkingDirectory` | `binding.workDir` |
| `ports` | `[HARNESS_BRIDGE_PORT]` |
| `getPortEndpoint({ port, protocol })` | `connectContainerToHarnessNetwork(ref)` → `${protocol}://${ip}:${port}`, memoized per session |
| `getPortUrl` | deprecated alias of the above |
| `stop` / `destroy` | **no-ops** — lifecycle belongs to the lease layer and the owner, never a harness |
| `restricted()` | today's basic session |
| network policy / request transformations / `setPorts` | omitted (optional members; no enforcement primitive today) |

`buildHarnessAgent` drops `bridgeIp`; `createClaudeCode` drops the
explicit `portEndpoint` and keeps `port: 4000`; neither harness step
calls the bridge helper itself. The 0006 boundary (membership of the
private `sweatshop-harness` network, never a published port) is
unchanged — it just sits behind `getPortEndpoint`.

### Run sandboxes outlive the run

The `finally` no longer destroys. A finished run's sandbox is reaped
like a chat's, on a **shorter** window: stop after 10 minutes idle,
destroy after 3 days (chats stay 30 minutes / 14 days). Purging the run
destroys it; a run that inherited a chat's binding never touches the
sandbox. `sandbox-gc` picks windows by `owner_kind` (env-overridable as
today), and stops deleting rows on destroy — it marks them `destroyed`,
as 0011 already requires of `destroySandbox` (the script still
deletes, so destroyed sandboxes lose their call history today).

### Project config drives the provider

`SandboxSpec` carries the project's `sandbox_configs.image_ref`;
`createContainer` uses it (falling back to `localhost/sweatshop-sandbox`).
`network_policy` stays recorded-but-unenforced; noted, not in scope.

### Inspecting from outside

Post-mortems should not require joining a sandbox. Two chat tools,
available without a project:

- `inspect` — read-only view of a run or conversation: transcript,
  harness events, and 0011's per-call sandbox attribution.
- `sandbox_exec` — run one command in a named sandbox without binding
  to it (resumes it if stopped). Starting an agent inside it is just a
  new chat or run that attaches.

## Explicitly not changing

- **One harness run at a time** (0006). Note: the slot is keyed by
  conversation, not sandbox, so two chats attached to one sandbox can
  each run a harness at once. Acceptable given attach is mostly
  after-the-fact; the comment in `harness-step.ts` is corrected to say
  so.
- **HarnessAgent's constructor `sandbox` provider** — we own lifecycle
  through leases; the SDK explicitly supports caller-owned sessions.
- **`experimental_sandbox` on the chat `WorkflowAgent`** — deferred. The
  SDK uses it in the workflow body (tool execute and description
  resolution), so it would need a workflow-serializable session class
  whose methods are steps, and long-lived `spawn` cannot be one. Nothing
  needs it until we adopt a third-party sandbox-aware tool; the binding
  is what the goal needs.

## Phases

1. **Network session.** `toNetworkSandboxSession`, both harness steps
   switch, `bridgeIp` plumbing deleted. Verified by a unit test
   (`getPortEndpoint` lazy + memoized against a fake) and the opt-in
   claude spike (`CLAUDE_SPIKE=1 CLAUDE_SPIKE_LIVE=1`).
2. **Binding in chat.** Schema + migration (binding on the owner;
   existing `sandbox_pref` rows map to `pending`/`bound`/`none`),
   `openSandbox(binding)`, bash/pi/claude take the binding; attach
   copies the target's binding (shared `workDir`); composer chooses only
   on a fresh conversation. Sandboxes tests cover pending→bound once,
   attach-copies-workDir, and that inherited bindings never stop/destroy.
3. **Machines inherit.** `start_machine` passes the chat's binding
   (`fresh` opt-out); runs carry a binding instead of `containerName` +
   `/work/<runId>`; agent stages get bash/pi/claude.
4. **Lifecycle.** Remove end-of-run destroy; per-owner-kind GC windows;
   GC marks rows `destroyed`; purge destroys owned run sandboxes.
4b. **Reaping in the app** (added 2026-10-02, approved in chat). One
   reaper (`lib/sandboxes/reaper.ts`) run by a timer from Next's
   `instrumentation.ts` (first pass 30 s after boot, then every 5 min;
   `SANDBOX_REAPER=off` disables), by "Run cleanup now" on `/sandboxes`
   (`POST /api/sandboxes/reap`), and by `npm run sandbox:gc` (now a thin
   client of that route). Sandboxes with live work — an active chat
   turn or harness run in a bound conversation, or a running/waiting
   run — are never reaped. Manual Stop / Destroy per sandbox
   (`POST /api/sandboxes/<id>`, refused while busy; Destroy confirms
   what it strands). The eve-container reaping is retired (leftovers
   removed once by hand).
5. **Project image.** `image_ref` reaches `createContainer` (resolved in
   the lease layer at create time; no config → the `default` config).
6. **Outside inspection.** `inspect` + `sandbox_exec` (`lib/agent/tools/
   inspect.ts`), offered in every chat. `inspect` takes a chat, run, or
   stage-visit id; `sandbox_exec` takes a sandbox id or a chat/run id
   and runs in the owner's workDir (overridable). The `attach_sandbox`
   chat tool was removed in phase 2 — attaching is a start-of-chat
   choice in the composer.

Each phase lands green on its own; phases 1 and 5 are independent of the
rest.

## Follow-ups (not now)

- Opt-in `git worktree` for a child that wants an isolated checkout in
  the same sandbox — only if same-directory collisions start to hurt.
- Fork instead of attach: `podman commit` (or a VM snapshot) into a new
  sandbox for a collision-free copy of another run's exact state.
  Depends on phase 4 (a destroyed sandbox cannot be snapshotted).
- Loosening the one-harness slot for agent-driven parallel harness
  calls.
- Enforcing `network_policy`.
- `experimental_sandbox` for chat, if a sandbox-aware tool is adopted.
