# 0013 — AI SDK sandbox sessions: workflow-serializable + network

Status: **draft (2026-10-02)** — awaiting Chad's approval.

## Goal

Make our podman sandboxes first-class AI SDK 7 sandbox sessions on both
agent surfaces:

1. **Chat (WorkflowAgent):** the turn passes the conversation's sandbox
   as `experimental_sandbox`, so sandbox-aware tools — ours and
   off-the-shelf — get it from the execute options instead of each tool
   acquiring it by hand.
2. **Harnesses (HarnessAgent):** the session we hand `runHarnessAgentStep`
   is a full `HarnessV1NetworkSandboxSession`, not the "basic" fallback,
   so the claude adapter resolves its bridge endpoint through
   `getPortEndpoint` and the hand-wired `bridgeIp` plumbing goes away.

Non-goals: switching to HarnessAgent's constructor-level `sandbox`
provider (we own sandbox lifecycle through leases — docs/0010 — and the
SDK explicitly supports caller-owned sessions), and sandbox templates /
`onBootstrap` snapshots (separate question; our image is prebuilt).

## Why

Read against the installed packages (ai 7.0.122, @ai-sdk/workflow
2.0.53, @ai-sdk/harness 1.0.132, harness-claude-code 1.0.136):

- `lib/sandboxes/ai-sdk-adapter.ts` says it exists "so WorkflowAgent's
  `experimental_sandbox` and sandbox-aware tools work unchanged", but
  `workflows/chat/turn.ts` never passes `experimental_sandbox`. Chat
  `bash` reaches the sandbox through its own `bashStep` →
  `acquireConversationSandbox`. A tool written against the AI SDK
  sandbox contract cannot be dropped into chat today.
- The adapter returns a plain `Experimental_SandboxSession`. The harness
  docs call that a restricted fallback "only when your project cannot
  expose the full network session". Because of it, claude needs
  `connectContainerToHarnessNetwork` + `portEndpoint: ws://${bridgeIp}:4000`
  baked into `buildHarnessAgent`; harness-claude-code's own code checks
  `"getPortEndpoint" in sandboxSession` and only demands an explicit
  `portEndpoint` when it is missing. The harness also reads
  `defaultWorkingDirectory` from a network session instead of probing
  `pwd`.

## Finding that shapes part 1

In `@ai-sdk/workflow` the sandbox is **not** an argument of
`doStreamStep`. It is used in the workflow body: `serializeToolSet`
resolves function-valued tool descriptions with it, and `executeTool`
passes it to `execute`. So whatever we pass as `experimental_sandbox`
lives in the workflow VM, where Node APIs are forbidden (AGENTS.md
workflow-transform rule), and gets serialized if it is ever handed to a
step.

A plain `toSandboxSession(handle)` object therefore cannot be passed. The
Workflow SDK already has the right primitive: **"use step" instance
methods on a class with `WORKFLOW_SERIALIZE`/`WORKFLOW_DESERIALIZE`**
(vendored `docs/workflows/Workflows.md`, "Instance Method Step
Transformation") — the same serde protocol `SerializableChatModel`
already uses.

## Design

### Part 1 — `WorkflowSandboxSession` (chat)

A new `workflows/chat/sandbox-session.ts`:

```ts
export class WorkflowSandboxSession implements Experimental_SandboxSession {
  constructor(readonly data: { conversationId: string; projectId: string | null; workDir: string }) {}
  get description() { /* names data.workDir — pure, workflow-safe */ }

  async run(options) {
    "use step";
    const { handle } = await acquireConversationSandbox(...); // dynamic import
    return toSandboxSession(handle, this.data.workDir).run(options);
  }
  // readTextFile / readBinaryFile / writeTextFile / writeBinaryFile: same shape
  // readFile / writeFile / spawn: see open questions — streams cannot
  // cross a step boundary.

  static [WORKFLOW_SERIALIZE](s) { return s.data; }
  static [WORKFLOW_DESERIALIZE](d) { return new WorkflowSandboxSession(d); }
}
```

- **Lazy creation is preserved:** constructing the object does nothing;
  the first method call acquires the lease (dedicated-on-first-use, per
  0010's defaults). The `sandbox_pref` is still resolved per call inside
  the step, so attach/none semantics are unchanged.
- `turn.ts` builds it only when the toolset would include sandboxed
  tools (same gate as 0011), and passes it as `experimental_sandbox` on
  the `WorkflowAgent`.
- `bash` becomes a sandbox-aware tool: `execute(input, { experimental_sandbox })`
  → `experimental_sandbox.run(...)`. The step boundary moves from
  `bashStep` into the session method; output clipping stays in the tool.
- **0011 attribution:** today `runBash` records `toolCallId → sandboxId`.
  The session method has no tool call id. Option: the tool records
  attribution with a tiny step after `run` resolves (the lease is
  already acquired, so it is a cheap lookup). Preferred over threading
  the id into the session.
- `pi`/`claude` stay as they are: they run as one durable step with
  their own semantic-step loop and need the full handle (spawn, network),
  which is part 2's object, not this one.

### Part 2 — network session (harnesses)

Extend `toSandboxSession` (or add `toNetworkSandboxSession` beside it) to
return `HarnessV1NetworkSandboxSession` when given a lease handle:

| Member | Implementation |
| --- | --- |
| `id` | the lease's `sandboxes.id` |
| `defaultWorkingDirectory` | the work root (`/work/<owner>`) |
| `ports` | `[HARNESS_BRIDGE_PORT]` |
| `getPortEndpoint({ port, protocol })` | `connectContainerToHarnessNetwork(ref)` → `${protocol}://${ip}:${port}` (memoized per session) |
| `getPortUrl` | deprecated alias → `getPortEndpoint(...).url` |
| `stop` / `destroy` | **no-ops** — lifecycle belongs to the lease layer (idle reaper, owner deletion), never to a harness |
| `restricted()` | the existing basic session |
| `setNetworkPolicy`, request transformations, `setPorts` | omitted (optional; no enforcement primitive today) |

Then `buildHarnessAgent` drops `bridgeIp`, `createClaudeCode` drops the
explicit `portEndpoint` (keeps `port: 4000`), and both harness steps
stop calling `connectContainerToHarnessNetwork` themselves. The
`sweatshop-harness` network-membership boundary (0006) is unchanged —
it just moves behind `getPortEndpoint`.

## Phases

1. **Network session (part 2).** Smallest, self-contained; verified by
   the opt-in claude spike (`CLAUDE_SPIKE=1 … CLAUDE_SPIKE_LIVE=1`) and
   a unit test that `getPortEndpoint` is lazy and memoized against a
   fake. Both harness steps switch over.
2. **Workflow sandbox session (part 1), run/read/write only.** Unit
   test: serialize → deserialize round-trip, description is pure,
   methods are registered steps. `x-chat` test: a scripted turn that
   calls `bash` through `experimental_sandbox` against a fake provider.
3. **Move `bash` onto it**, delete `bashStep`, keep 0011 attribution
   green (sandboxes tests).

## Open questions

1. **Streaming members** (`readFile`, `writeFile`, `spawn`) return or
   take `ReadableStream`s, which do not survive a step boundary. Options:
   buffer inside the step (fine for files; wrong for `spawn`), or throw
   "not supported in chat — use the pi/claude tools" for `spawn`.
   Proposal: buffer files, throw for `spawn`.
2. **One step per sandbox call.** A tool doing many small reads now
   records a step each in the run log. Acceptable for our tools (bash is
   one call); worth noting for third-party tools.
3. **Is the SWC transform happy with a class whose step methods dynamic-
   import Node modules?** The vendored spec says yes; phase 2's first
   task is a two-method spike before anything else depends on it.
