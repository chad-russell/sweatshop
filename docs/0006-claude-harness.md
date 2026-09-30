# 0006 — Claude harness on project sandboxes

Status: **implemented; bridge verified (2026-09-30)** — the `claude`
tool, multi-harness store, and private bridge seam are in, and the
opt-in spike proves bootstrap + WS handshake on bee. Live Claude turns
remain gated on an authorized `ANTHROPIC_API_KEY` (Console key); see
Verification.

## Goal and boundaries

Offer Claude as a second coding harness for project-bound Eve conversations, without replacing Pi. The intended tool surface is three separately callable, analogous tools: `pi`, `claude`, and eventually `cursor`. Claude must work on the **same session-owned project workspace** as Eve's bash and Pi, and its activity must be inspectable during and after a run. A conversation without a project remains unsandboxed and cannot invoke coding harness tools.

This is a design for the `@ai-sdk/harness-claude-code` adapter, which drives the official Claude Agent SDK/CLI in the sandbox; it is **not** a hand-written parser around `claude -p`. Unlike Pi, Claude runs a bridge process inside the sandbox and communicates with the app over an exposed WebSocket endpoint. The adapter is experimental and version-sensitive. See [Claude adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code.md) and [HarnessAgent custom sandbox orchestration](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent.md#custom-sandbox-orchestration).

Out of scope: ticket-workflow adoption, host-executed PR tools, UI-managed login, general harness selection settings, harness approval cards, harness-event SSE, and durable reattachment of unfinished Claude turns. The last three deserve separate lifecycle designs; neither an approval prompt nor a live feed follows automatically from adding the adapter.

## Current constraints

- `agent/tools/pi.ts` runs Pi in the Eve runtime, using `ctx.getSandbox()` and `toSandboxSession`. Pi and Eve share `/workspace`; Pi's harness session is cached only in the runtime process.
- `agent/sandbox.ts` uses Eve's `DockerSandbox.environment()` and opens a sibling Podman container with `networkPolicy: "allow-all"` for project work. The common `ctx.getSandbox()` handle supplies shell/files but not a published port, container identity, or a host-reachable endpoint. The vendored Eve Docker guide documents only `networkPolicy` as a live option (`vendor/eve/docs/sandbox/docker.mdx`). Do not assume `ctx.getSandbox()` exposes provider internals.
- `toSandboxSession` implements a basic `Experimental_SandboxSession`; its `spawn` is run-to-completion with replayed output, not a long-lived streaming process. It cannot be passed to Claude expecting the Pi behavior. The Claude adapter needs a live bridge, a way to start it, and an exposed port/endpoint; the adapter docs show an explicit `portEndpoint` for a restricted basic session when a network-capable session cannot be supplied.
- `harness_runs` has one row keyed by Eve session ID and `/h/<eveSessionId>` assumes one harness per conversation. `harness_events` has no harness/run discriminator; queries return at most 1,000 earliest events. SQLite WAL already bridges the separate Eve and Next processes, while `/h` polls every two seconds.

## Authentication decision gate

Chad confirmed the credential was printed by `claude setup-token`. Anthropic documents that command as generating a one-year **subscription OAuth setup-token** for `CLAUDE_CODE_OAUTH_TOKEN`, not a Console API key. The `sk-ant-…` prefix does not change its provenance. **Do not paste the value into source, chat, logs, or this design.** Do not validate it by accidentally spending a live run against the wrong billing account.

A Console API key is a distinct credential with API billing. The Claude adapter documents `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, gateway variables, and native host subscription discovery, but does **not** document forwarding `CLAUDE_CODE_OAUTH_TOKEN` as an auth environment setting. It uses the Claude Agent SDK. Anthropic's [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview.md) says that, absent prior approval, third-party developers may not offer claude.ai login or subscription rate limits in their products built with the SDK, and recommends API-key authentication. The fact that an unmodified CLI can consume a setup-token in scripts does not establish whether this embedded product may consume it. This is a product-use question, not a claim that Chad has done anything improper.

**V1 go/no-go:** select a verified, authorized Console API key or approved gateway/enterprise arrangement for this integration; otherwise pause implementation pending clarification or approval from Anthropic. Do not reinterpret a subscription setup-token as `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, silently fall back to the host's native subscription, or hard-code auth into the sandbox image. For a Console key, choose the adapter's isolated `auth: { ANTHROPIC_API_KEY: ... }` rather than its host-environment `auto` mode (which can prefer a gateway or discover a host subscription). Keep the secret in app server configuration, inject it only for the Claude process, and redact it from logs, events, errors, and tool outputs. The adapter's `credentialForwarding` hook is not a restriction on host-side credential discovery; review the actual forwarding mode before a live run. With our basic Podman adapter, assume the bridge process receives the credential until proven otherwise. See [Claude Code authentication](https://code.claude.com/docs/en/authentication.md) and [adapter authentication](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code.md#authentication).

## Proposed architecture

```text
project-bound Eve conversation
  ├─ existing Eve bash + Pi → same Eve session sandbox /workspace
  └─ separate `claude` tool
       ├─ ctx.getSandbox() → the existing, session-owned sandbox
       ├─ network bridge capability → sandbox bridge port + host-reachable WS URL
       ├─ HarnessAgent(createClaudeCode({ auth: isolated credential,
       │    port, portEndpoint, ... }), id keyed by Eve session)
       ├─ Claude Agent SDK/official runtime launched inside that sandbox
       └─ callbacks → SQLite harness run/events → branded /h view
```

**Keep one workspace and one ownership chain.** Do not provision a second workflow container for Claude while claiming it shares Eve's workspace. Do not mount the host repo to simulate sharing. The Eve sandbox owns its lifecycle; the harness destroys/stops only its own bridge/session. Its working directory must point at the intended `/workspace` repo location, not a newly created adapter-default working directory disconnected from the cloned repos; prove this with a write/read from both Claude and Eve bash.

**Bridge seam (proved — see Verification):** the AI SDK documents the idiomatic `HarnessAgent` + network sandbox pattern and a custom-sandbox path with an explicit bridge endpoint. The adapter owns the Agent SDK bridge protocol, stream normalization, and CLI bootstrap; we do not implement those ourselves. The integration question was whether the pinned Eve Docker provider could provide a safely scoped port/endpoint via its supported APIs — it cannot (no published ports), so the sanctioned fallback applies: a private shared podman network that the dev container and each sandbox join (membership is the boundary; no published LAN port). Cursor's published ACP adapter also requires a network sandbox and exposed bridge port, so the seam is reusable for that eventual tool without implementing Cursor in this phase. This is not *only* a networking task: dependency compatibility, auth forwarding, shared workdir, session/view identity, and lifecycle remain application integration work. See [Cursor adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/cursor.md). The exposed WebSocket is a control channel into a code-executing runtime: the adapter's bridge-token authentication covers it (random 32-byte token per session), ports are per-sandbox netns so they cannot collide, and other sessions cannot reach a sandbox's address without joining the network — which requires the host podman socket. The remaining caveats: the sandbox container is identified by a marker-file scan of `eve.sandbox`-labeled containers (names are provider-internal hashes), and the bridge process idles in the sandbox between calls (dies with the container).

**Session and view identity:** keep Pi's historical `/h/<eveSessionId>` links stable. Add an explicit harness identity (at minimum Eve session ID + harness kind, and preferably a run ID for repeated calls) to the new rows and queries rather than overwriting Pi's run/index or mixing events. Give Claude a distinct URL or typed route that cannot alias Pi; migrate the existing Pi view without breaking old links. A unique key must prevent two concurrent calls to the same harness session; define whether different harnesses may run concurrently in one sandbox (v1: reject concurrent runs to avoid competing edits). Use SQLite for cross-process activity and status, not a module Map as the UI transport. Choose bounded cursor/pagination rather than the current first-1,000-events truncation before promising complete Claude transcripts. Retain the two-second poll in v1; SSE is not part of the bridge WebSocket and is not needed for the browser viewer.

**Failure and lifetime:** avoid labeling errors `completed` via an unconditional `finally`; record success/failure with a bounded, redacted error description and preserve the transcript. On server restart, Pi-like module caching cannot resume a Claude turn. V1 must explicitly surface interrupted/stale runs and reject continuation rather than silently starting a fresh Claude turn as if history survived. If an in-flight turn must survive restarts, add persisted harness resume/continuation state and sandbox reattachment as a separate phase, using the documented `detach`/`stop`/`continue` lifecycle. Remove/stop the bridge when the owner sandbox closes; do not destroy Eve's sandbox from a tool call.

## Delivery sequence and evidence

1. **Credential + dependency review (no secret in tests):** treat the confirmed `claude setup-token` as a subscription credential; obtain an authorized API/gateway route or explicit permission for this Agent SDK use before a live Claude run. Inspect installed/version-matched `@ai-sdk/harness*` package APIs inside the dev container before coding. Ask before adding `@ai-sdk/harness-claude-code` or changing existing pins; verify dependency deduplication with Pi and the AI SDK/provider-utils line. Do not upgrade the pinned Pi runtime casually.
2. **Bridge feasibility spike, no Eve chat:** use a disposable Podman project sandbox with a private reachable port; show bridge bootstrap, authenticated WebSocket connection, model auth, a bounded Claude turn and cleanup. Verify that the path to a port on the **actual Eve session-owned sandbox** exists before turning this into production code; a successful separate-container spike alone is insufficient.
3. **Same-sandbox integration:** add the separate project-only `claude({ task })` Eve tool and isolated per-conversation harness session; exercise an edit and commit, then read branch and content through Eve bash in the same container. Ensure the Pi tool still works and a non-project conversation cannot start Claude.
4. **Multi-harness persistence and view:** schema migration with backward-compatible Pi history, event/run identity, error status, typed links and incremental event retrieval; UI labels the correct harness. Use mocked harness/bridge tests for lifecycle and event projections, not live model calls in `npm run test`. Keep the live spike explicitly opt-in and secrets out of fixtures.
5. **Verify and commit:** inside the dev container run `npm run typecheck`, `npm run lint`, `npm run test` before each conventional commit. Record the real integration transcript, same-workspace evidence, bridge exposure checks, credential mode (not its value), and unresolved follow-ups in this doc.

## Verification (2026-09-30)

- **Network seam (proven on bee):** host-side processes have no route to
  podman's internal bridge subnets (a dev-container fetch to a sandbox's
  `10.88.x` address fails), and Eve 0.67.2's Docker provider supports no
  published ports — `startDockerContainer` emits no `-p`. The sanctioned
  seam is membership instead: a private `sweatshop-harness` podman
  network that `./dev` creates and joins at startup, with each
  conversation's sandbox connected at claude-tool time. Sibling
  containers on that network reach each other by IP/DNS (verified with a
  listener container); bridge-network containers keep internet + LAN DNS
  (verified: npm registry 200, `git.crussell.io` resolves).
- **Sandbox capability:** the eve sandbox image (`ghcr.io/vercel/eve`)
  ships Node 24 + pnpm + git — the adapter's in-sandbox bootstrap
  prerequisites. Eve's session `spawn()` is a real streaming spawn (env
  via `docker exec -e`, stdout/stderr streams, wait/kill via pidfile) —
  the replay spawn could never host a bridge; `toSandboxSession` now
  passes a backing spawn through when present.
- **Store (tests):** 38 store tests green — per-harness event isolation,
  id-cursor paging, failed status with clipped error, restart clears
  error, per-(session, harness) run rows, active-run lookup. Migration
  0007 applied to the dev db with pi history intact (16 events, 1 run).
  Two drizzle-kit 0.31 defects worked around: composite primary keys
  crash its snapshot generator (→ unique index on a rowid table), and
  its table-rebuild copy SELECTs not-yet-existing added columns
  (→ hand-corrected to `NULL`).
- **Bridge spike — GO** (`tests/claude-spike.integration.test.ts`,
  `CLAUDE_SPIKE=1`, 2026-09-30): disposable container on the eve image →
  joined the private network (endpoint `ws://10.89.x.x:4000`) →
  `createSession` bootstrapped the bridge in-sandbox (recipe files +
  `pnpm install` inside the sandbox) and completed the authenticated WS
  handshake → `destroy` + container cleanup, 23.5s end to end, no model
  call. Three seam defects it surfaced, all fixed: `workingDirectory`
  was dropped from `run` (the recipe runs `pnpm install` in its own
  bootstrap dir — now `docker exec -w` everywhere), env must ride as
  `docker exec -e` flags (`mkdir "$BOOTSTRAP_DIR"`), and Go templates
  need `{{(index .Networks "name").IPAddress}}` (dashes break field
  access).
- **Not yet verified live:** a real Claude turn. `ANTHROPIC_API_KEY`
  (Console) is unset; the tool errors actionably until it is provided.
  When it is: `CLAUDE_SPIKE=1 CLAUDE_SPIKE_LIVE=1` runs one bounded
  generate in the spike, then a project conversation exercises the
  `claude` tool end-to-end (edit + commit read back through eve bash —
  same-workspace evidence).
- Operational notes: `./dev` must be restarted once to join the harness
  network (the tool detects and reports this). First claude session per
  sandbox bootstraps the bridge (minutes); the bridge process idles in
  the sandbox between calls and dies with the container. A moved
  endpoint (sandbox restart) evicts the cached session — Claude history
  does not survive it (v1 contract).

## Independent follow-ups

- **Approval cards:** `permissionMode` applies to adapter-native tools; `toolApproval` covers host-executed tools. A harness approval pauses an inner turn; today's `claude`/`pi` tool would be a plain Eve tool, not a durable Eve workflow tool. Design the persisted request/response/continuation and Eve HITL UI before claiming action-level approvals. An Eve approval on the outer `claude` call is a different gate. Do not use `allow-all` as a substitute for a reviewed permission policy when the integration is made available beyond a trusted local sandbox.
- **Harness SSE:** optional replacement for `/h`'s SQLite polling, with event-ID replay and reconnect. The parent Eve conversation already streams independently. SSE does not solve the Claude bridge, inner approvals, or interrupted turns.

## Review questions

1. **Resolved 2026-09-30:** `pi` and `claude` ship as separate
   Eve-callable tools; `cursor` is the intended third (the bridge seam
   is deliberately reusable for it).
2. **Accepted:** v1 ships without action-level approvals and without
   cross-restart turn continuity — failures and moved endpoints are
   surfaced, never silently reused.
3. **Still open — auth:** Chad selected the Console-API-key route; the
   `claude` tool stays env-gated off until an authorized key lands in
   `.env.local`. The subscription setup-token is not used anywhere.

## References

- `docs/0005-harness-agents.md` — existing Pi architecture and explicitly open follow-ups.
- `vendor/eve/docs/sandbox/docker.mdx`, `vendor/eve/docs/tools/human-in-the-loop.md` — version-matched Eve sandbox and input contracts.
- [Claude Code adapter](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code.md), [HarnessAgent](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent.md), [Harness tool approvals](https://ai-sdk.dev/docs/ai-sdk-harnesses/tools.md).
- [Claude Code authentication](https://code.claude.com/docs/en/authentication.md), [Anthropic Agent SDK use guidance](https://code.claude.com/docs/en/agent-sdk/overview.md).
