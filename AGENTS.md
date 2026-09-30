# AGENTS.md — sweatshop

Instructions for agents working in this repo. Read before doing anything.

## What this is

sweatshop is an evolving set of additions and tools around an idiomatic deployment of vercel's Eve agent.
It uses established tools where possible, preferring  build over buy and preferring libraries and SDKs from 
the vercel AI ecosystem where they exist.

It is being built slowly and deliberately from an empty repo — properly
engineered, never vibe-coded. It replaces the prototype at `~/sweatshop`
(see "Old repo policy").

## Ground rules

- **Branch:** all work on `main` unless told otherwise. There is no remote
  yet; that's fine.
- **Commits:** conventional commits — `type(scope): subject` (feat, fix,
  docs, chore, refactor…). Commit often enough that history reads as a
  logical sequence of small steps.
- **Process (hybrid by size):** small or mechanical changes go straight to
  commits. Anything architectural — new subsystem, dependency decision,
  layout change, anything that sets precedent — gets a numbered design doc
  under `docs/` (`docs/NNNN-slug.md`) approved by Chad before
  implementation starts.
- **Quality bar:** `npm run typecheck`, `npm run lint`, and `npm run test`
  pass before every commit (run inside the container — see Environment).
  Store-layer tests run against per-worker temp databases; when the first
  agent-behavior test arrives, build a mock LLM first so tests never wait
  on a real model call.
- **No sloppy growth:** prefer deleting over accumulating. Ask before
  adding a dependency. Every file earns its place.

## Architecture (current state)

- Single Next.js (App Router) app at the repo root; the eve agent lives in
  `agent/` beside the app code; `next.config.ts` wraps `withEve()` so the
  agent's HTTP API mounts at same-origin `/eve/v1/*`.
- The browser talks to the agent exclusively through `useEveAgent()` from
  `eve/react` (the eve channel transport — there is no `/api/chat` route).
- UI is Vercel AI Elements on shadcn + tailwind. The visual system is the
  `DESIGN.md` token contract: semantic tokens only, never raw hex/oklch in
  TSX; themes `clickhouse` (default), `cal`, `nova`.
- Model (eve agent): Z.AI GLM coding plan via `zhipu-ai-provider` on
  the coding plan's OpenAI-compatible endpoint
  (`api.z.ai/api/coding/paas/v4`); default `glm-5.3-flash`; key in
  `ZAI_API_KEY` (`.env.local`). (The pi harness separately uses the
  Anthropic Messages surface — see 0005.)
- Auth: LAN-only personal tool. `agent/channels/eve.ts` admits every caller
  via `none()` as a synthetic principal. **Hard rule: replace with a real
  verifier before any internet exposure.**
- Persistence north star: SQLite (single db, or split where it makes
  sense) + S3 object storage. **No postgres and no other backends — ever.**
- The app store lives in `data/sweatshop.db` (better-sqlite3 + drizzle,
  migrations in `drizzle/`, apply with `npm run db:migrate`): a
  `conversations` index plus the append-only `conversation_events` mirror
  of eve's stream, written by `agent/hooks/mirror.ts`. The mirror is a
  derived, rebuildable view of eve's authoritative stream — the dual-write
  invariants in docs/0002 govern it. Transcripts replay from eve, never
  from the mirror.
- Projects & sandboxes (0004, Phases A–D + Path B shipped): `projects`
  (1+ git repos) reference shareable `sandbox_configs`; git credentials
  resolve by host through the pluggable `GitHost` seam (`lib/git-hosts/`
  — github + forgejo, `installAuth` + `createPR`). Conversations bind to
  a project at creation via the `x-sweatshop-project` header (channel
  principal attributes, immutable for the session); the sandbox selector
  (`agent/sandbox.ts`) then opens a session-owned sibling container on
  host podman, clones the project's repos into `/workspace/<repo>`, and
  injects credentials. Unbound conversations get no sandbox. Entities
  are managed db-first via `npm run db:seed` (secrets from env only);
  `/p/[projectId]` starts a project conversation; `create_pr` is the
  agent's PR tool.
- run_ticket pipelines (0004 Path B): raw Workflow SDK workflows
  (`workflows/`) started directly by the UI button on project pages or
  `POST /api/tickets` — no agent session. Phases are `WorkflowAgent`s
  sharing one provisioned container (`lib/sandboxes/` — shared workspace
  setup, direct provisioner, AI SDK SandboxSession adapter) with a
  durable approval gate (`defineHook`); status lives in `ticket_runs`
  and `/t/[ticketId]` is the live run view. Workflow-transform rule:
  Node-touching code only inside `"use step"` functions. Keep
  `@ai-sdk/workflow` aligned with the installed `ai` line (2.0.53 ↔
  ai 7.0.122 / provider-utils 5.0.51) or tool types split across nested
  package copies.
- Harness agents (0005/0006): project conversations have `pi` and
  `claude` tools — separate coding harnesses on the SAME session
  sandbox. pi (`@ai-sdk/harness-pi`) runs in-process on GLM via the
  Z.AI coding plan's Anthropic Messages surface
  (`https://api.z.ai/api/anthropic`), through the shared AI SDK adapter
  (`toSandboxSession` — accepts any `{ run(command, env?) }` shell plus
  an optional AI-SDK-shaped streaming `spawn`). claude
  (`@ai-sdk/harness-claude-code`, pinned exactly 1.0.136) runs the
  official Agent SDK as an in-sandbox bridge process; the eve runtime
  reaches it over the private `sweatshop-harness` podman network (host
  processes have no route to podman bridge subnets; Eve's Docker
  provider publishes no ports — membership is the boundary, never a
  published LAN port). claude auth (0006 amendment): a claude
  setup-token passed as `CLAUDE_CODE_OAUTH_TOKEN` through the adapter's
  env channel (`auth: "direct"` — no gateway, no host discovery);
  single-user personal use per Chad's recorded decision, revisit if
  productized. The tool is env-gated off until the variable is set.
  One harness session per conversation × harness (module cache; a moved
  bridge endpoint evicts rather than silently reuses). Harness activity
  persists in `harness_events` + `harness_runs` keyed (session, harness)
  — `/h/<harness>/<eveSessionId>` is the one shape for every harness
  (pi, claude; re-decided 2026-10-01); legacy `/h/<id>` and
  `/h/<id>/<harness>` URLs permanent-redirect. Failures record as failed
  with a
  clipped error, events page by id cursor. Packaging pins:
  `pi-coding-agent` exactly 0.85.1; harness-pi 1.0.134 / harness
  1.0.132 / harness-claude-code 1.0.136. Adapter rules: env goes as
  `docker exec -e` flags, exec uses `bash` not `sh`, and bridge
  processes need the real streaming spawn (run-to-completion replay
  cannot host one). Opt-in spike:
  `CLAUDE_SPIKE=1 npx vitest run tests/claude-spike.integration.test.ts`
  (+ `CLAUDE_SPIKE_LIVE=1` with `CLAUDE_CODE_OAUTH_TOKEN` set for a
  bounded turn).

## Environment

Nothing is installed on the host; all development happens in podman:

- `./dev` — install deps if needed, then run the dev server attached
  (Ctrl-C stops). App on http://localhost:3300 (host 3000 is taken by an
  unrelated service; override with `SWEATSHOP_PORT`).
- `./dev install` — `npm install` inside the container.
- `./dev exec -- <cmd>` — one-off command in a container with the same
  mounts (works whether or not the dev container is running).
- `./dev shell` — interactive shell in the dev container.
- `./dev build` — rebuild the dev image from `Containerfile.dev`.
- `./dev clean` — remove the dev container; node_modules volume survives.
- Container: image `localhost/sweatshop-dev` (built from
  `Containerfile.dev` — node:24-trixie-slim + docker-cli), repo
  bind-mounted at `/workspace`, node_modules in a named volume so the
  host tree stays clean, run as container root (rootless podman maps it
  to the host user), `.env.local` via `--env-file`, host port 3300 →
  container 3000. When the host rootless podman socket exists it is
  mounted at `/var/run/docker.sock`, so the eve Docker sandbox provider
  creates session sandboxes as sibling containers on host podman.
  `./dev` also ensures a private `sweatshop-harness` podman network and
  puts every invocation on it (0006 — bridge harness connectivity;
  restart `./dev` after network changes for the runtime to join).
- eve requires Node ≥ 24.
- eve's dev watcher rebuilds authored artifacts on `agent/`-tree changes
  only. Code the agent imports from outside that tree (e.g. `db/mirror.ts`)
  needs a `./dev` restart to take effect in the running runtime.
- Agent shells must run podman under escalated (full-access) file
  permissions — podman writes runtime state under `/run`.
- eve's canonical docs are vendored at `vendor/eve/docs/` — read and grep
  them on the host. The `VERSION` file records which eve they document;
  re-sync with `npm run docs:eve` whenever the installed eve version
  changes. The same docs live inside the container at
  `node_modules/eve/docs`. `https://eve.dev/docs/llms.txt` tracks the
  LATEST release — use it for upgrade checks, not daily reference.

## Old repo policy

The prototype lives at `~/sweatshop`. It is a valid reference for
implementation details (Z.AI/zhipu provider wiring, channel auth patterns,
what specific eve APIs do) but **not** for design — it accreted spaghetti
and cruft, which is why this repo exists. Extract the specific fact you
need; write it fresh here. Never copy structure or code wholesale.

## Skills

Vendored under `.agents/skills/` (tracked by `skills-lock.json`):

- `ai-sdk` — load before writing any AI SDK / provider code.
- `ai-elements` — load before any chat UI work.
- `eve` — load before any agent work; it defers to the bundled docs above.
