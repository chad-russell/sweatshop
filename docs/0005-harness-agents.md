# 0005 — Harness agents on project sandboxes (pi first)

Status: **shipped (Phases A–C)** (2026-09-30) — see Verification.

## Endpoint decision (researched 2026-09-30)

Z.AI's coding plan exposes three protocol surfaces (docs.z.ai
/devpack/tool/others — which also lists **pi as an officially
supported tool**):

| Protocol               | Base URL                          |
| ---------------------- | --------------------------------- |
| **Anthropic Messages** | `https://api.z.ai/api/anthropic`  |
| OpenAI Chat Completions| `https://api.z.ai/api/coding/paas/v4` |
| OpenAI Responses       | `https://api.z.ai/api/v1`         |

**Chosen: Anthropic Messages.** The plan is productized around Claude
Code (CC-Bench trajectories, anthropic surface listed first) — their
best-tested agentic coding path; native thinking blocks map directly to
pi's `thinkingLevel`; prompt caching carries a cheaper credit
multiplier (long agentic sessions save real quota); pi-ai's anthropic
provider is first-class. The OpenAI surface mirrors our zhipu wiring
but pi needs its own ProviderConfig either way, so no reuse advantage.
Fallback if pi's anthropic ProviderConfig has friction:
openai-completions against `/api/coding/paas/v4`.

(Note: the prototype's claude-code wiring pointed at
`/api/coding/paas/v4` as "Anthropic-compatible" — the endpoint layout
has evolved since; today's table is authoritative.)

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

## Verification (2026-09-30)

- **Phase A (spike, `tests/pi-spike.integration.test.ts`, PI_SPIKE=1):**
  pi on GLM via Anthropic Messages against a provisioned container —
  branch `pi/spike`, commit `4b78cb8`, file content verified in-sandbox.
  Two adapter bugs found and fixed en route: run() must pass env as
  `docker exec -e` flags (POSIX expands `K=V cmd "$K"` before the
  assignment applies) and must use `bash`, not `sh` (pi emits
  bash-isms; dash errors on `(`).
- **Phases B–C (live conversation, transcript-level evidence):** the
  eve agent called the `pi` tool; pi created the file and committed on
  `pi/conversation` (`3291321`); the agent's own bash in the SAME
  sandbox confirmed branch + content — shared workspace confirmed.
  pi noted its write tool is scoped to its workdir and used its shell
  tool instead — expected shared-workspace behavior.
- **Packaging notes:** `@earendil-works/pi-coding-agent` pinned exactly
  `0.85.1` (newer versions break `@ai-sdk/harness-pi@1.0.134`'s
  imports); `@ai-sdk/harness-pi@1.0.134` + `@ai-sdk/harness@1.0.132`
  dedupe against our provider-utils 5.0.51 line.
- **Out of scope remains:** run_ticket pipeline adoption of pi, other
  harnesses, streaming pi output into the chat UI, durable harness
  reattach across dev-server restarts (module cache only).

## Harness visibility (2026-09-30, post-ship)

The pi tool records its full event stream (start/step/tool calls with
inputs+outputs/step texts/end) via HarnessAgent callbacks into
`harness_events` (sqlite) — **sqlite is the cross-process transport**:
the eve runtime writes, the Next server reads; an in-process Map failed
exactly because of that process split. Events land as they happen, so
`GET /api/harness/<eveSessionId>` works live (poll) and after the run;
the pi tool result carries the URL + tool-call count. Callback shapes
worth remembering: tool events carry `{ toolCall }` (name + input) and
`{ toolCall, toolOutput }` (output via `"output" in toolOutput`).

**Harness tools:** `HarnessAgent` accepts host-executed `tools` in the
constructor (README pattern) — create_pr can be handed to pi when a
task warrants in-loop PRs. Current stance: pi codes, the calling agent
coordinates and PRs (it holds conversation context; create_pr is a
trivial post-hoc call). Revisit per work-type, especially in pipeline
phases.

**Still open:** in-chat rendering of the event log (URL suffices for
now), SSE for push-style live attach (polling works today), forwarding
harness permission requests (`toolApproval`) into the chat as eve
approval cards.

## Risks / unknowns (pre-build; see Verification for outcomes)

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
