# 0005 — Harness agents on project sandboxes (pi first)

Status: **proposed** — awaiting approval.

## Goal

Run coding harnesses via `HarnessAgent` attached to the project
sandboxes, driven from conversations. Like chat today: un-sandboxed
conversations stay conversational; project conversations gain a harness
mode — the harness *requires* a sandbox (accepted). First harness:
**pi** (`@ai-sdk/harness-pi`) — chosen as the simplest: per its README,
"Pi runs in the host Node.js process and uses the sandbox as a remote
filesystem + shell — no bridge process is installed inside the
sandbox." No CLI in the sandbox image; pi drives the
`Experimental_SandboxSession` interface we already have an adapter for.

Out of scope this push: run_ticket pipeline adoption of the harness
(implement phase stays direct bash), other harnesses (claude-code,
codex), streaming live harness output into the chat UI, per-project
harness skills.

## Architecture

```text
conversation (project-bound, /p/[id])
  └─ eve agent tool `pi` (agent/tools/pi.ts)
       ├─ ctx.getSandbox()  → eve session sandbox
       ├─ toSandboxSession(…)  → AI SDK Experimental_SandboxSession
       │    (adapter generalized beyond ProvisionedSandbox to also wrap
       │     eve's session-sandbox surface)
       ├─ HarnessAgent({ harness: createPi({...GLM...}), id })
       │    └─ per-conversation session cache (module map keyed by eve
       │       session id; durable reattach later)
       └─ agent.generate({ session, prompt: task }) → result text
```

- **Model:** `createPi({ providers, auth, credentials, thinkingLevel })`
  — a custom provider entry registering GLM on the Z.AI
  Anthropic-compatible coding endpoint; the ZAI key supplied through
  the app-owned `credentials` store (never env-scraped by pi).
- **Deps:** `@ai-sdk/harness-pi@1.0.134` + `@ai-sdk/harness@1.0.132`
  (pins `provider-utils@5.0.51` = our line; no nested-copy type split).
- **Sandbox:** Path A (eve session sandbox) — the same container the
  conversation's bash tool uses, so pi's edits and the agent's bash see
  one workspace. Path B (provisioned containers) works through the
  existing adapter unchanged (pipeline adoption later).
- **Tool surface:** one tool, `pi({ task })`, available only when a
  project is bound (same guard as bash). Long-running is fine; v1
  returns the final text (streaming into chat later).

## Staging

- **Phase A — model spike (no eve):** deps installed; `createPi` with a
  GLM provider entry runs `agent.generate` against a directly
  provisioned spike container (existing adapter). Proves the provider
  config shape, auth, and pi's tool loop over our sandbox before any
  integration. Go/no-go on provider specifics.
- **Phase B — adapter generalization:** `toSandboxSession` accepts
  eve's session-sandbox shape (structural `run`/file ops) in addition
  to `ProvisionedSandbox`.
- **Phase C — the `pi` tool:** eve tool with per-conversation harness
  session cache; live verification in a spike conversation (pi performs
  a real edit + commit via its own read/write/edit/bash tools;
  transcript-level evidence per the PR-#31 lesson: the `pi` tool's own
  call and result, not a fallback).
- **Phase D — docs** (0005 verification, AGENTS.md, vendored pi docs if
  the package ships none useful).

## Risks / unknowns

- **ProviderConfig shape** (from `@earendil-works/pi-coding-agent`) —
  exact fields for an Anthropic-compatible custom endpoint are
  undiscovered until Phase A; the prototype proved the *endpoint* works
  with coding agents, not pi's config dialect.
- **Tool-call duration:** pi turns may run minutes inside one eve tool
  call; eve has no per-tool timeout by default — watch for dev-server
  behavior on very long calls.
- **spawn streaming:** pi is documented as fs+shell over the session;
  if it needs streaming `spawn` (our adapter's v1 replays completed
  runs), the adapter gains a real streaming spawn via
  `child_process.spawn` pipes.
- **Session continuity:** module-map cache lives while the dev server
  lives; pi supports persisted lifecycle state for durable reattach if
  we want it across restarts (later).
