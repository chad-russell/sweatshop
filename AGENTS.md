# AGENTS.md — sweatshop

Instructions for agents working in this repo. Read before doing anything.

## What this is

sweatshop is a personal software factory: a single Next.js app whose
agent runtime is the Vercel AI SDK (`WorkflowAgent`) on the Workflow SDK
(0010 — eve was removed 2026-10-01; docs/0010 records why and how). It
uses established tools where possible, preferring build over buy and
preferring libraries and SDKs from the vercel AI ecosystem where they
exist.

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

- Single Next.js (App Router) app at the repo root; `next.config.ts`
  wraps `withWorkflow()` (workflow routes at `/.well-known/workflow/v1`).
- Chat runtime (0010): one WorkflowAgent workflow run per turn
  (`workflows/chat/turn.ts` — one model step per slice via
  `stopWhen: isStepCount(1)`; steer messages drain between slices).
  sqlite is the source of truth (`messages.model_message` rows); the
  browser uses `useChat` + `WorkflowChatTransport` against
  `/api/x/chat/*` (client imports MUST come from
  `@ai-sdk/workflow/client` — the main entry pulls server modules into
  the browser bundle). Approvals are `defineHook` suspensions answered
  via `/api/x/input`; the model instance crosses step boundaries through
  `SerializableChatModel` (@workflow/serde class protocol).
- UI is Vercel AI Elements on shadcn + tailwind. The visual system is the
  `DESIGN.md` token contract: semantic tokens only, never raw hex/oklch in
  TSX; themes `clickhouse` (default), `cal`, `nova`.
- Chat models (lib/model.ts): Z.AI GLM coding plan via
  `zhipu-ai-provider` on the coding plan's OpenAI-compatible endpoint
  (`api.z.ai/api/coding/paas/v4`); default `glm-5.3-flash`; key in
  `ZAI_API_KEY` (`.env.local`). Per-conversation choice is a plain
  column (`conversations.model_id`). (Harnesses separately use the
  Anthropic Messages surface — see 0005.)
- Auth: LAN-only personal tool with no auth layer. **Hard rule: add a
  real verifier before any internet exposure.**
- Persistence north star: SQLite (single db, or split where it makes
  sense) + S3 object storage. **No postgres and no other backends — ever.**
- The app store lives in `data/sweatshop.db` (better-sqlite3 + drizzle,
  migrations in `drizzle/`, apply with `npm run db:migrate`): a
  `conversations` index; chat history as `messages` rows carrying a
  serialized ModelMessage (`db/chat.ts`, plus `steer_queue`,
  `conversations.active_run_id`); and the sandbox lease registry
  (`sandboxes` + `sandbox_attachments`, `db/sandboxes.ts`). The eve-era
  `conversation_events` mirror is RETIRED (0010 Phase 6 — nothing writes
  it; db/mirror.ts stays as the ingest utility for tests/historical
  rebuilds, and 0002's dual-write invariants are historical). Eve-era
  transcripts were imported into `messages` (`npm run chat:import`,
  idempotent).
- Conversation organization (0007): per-group (project, or Chats) folder
  trees (`folders`, `conversations.folder_id`), an "Unfiled" list per
  group split by age, archive (searchable) and trash (30-day lazy
  purge, not searchable), manual rename pinned via `title_source`, and
  GLM-Flash generated title+summary (`lib/titles.ts`, fired from the
  chat turn after persisting, max two calls per conversation). All invariants live in
  `db/organize.ts`; routes under `app/api/{folders,conversations}`; the
  sidebar is `components/sidebar/*` with native drag and drop plus a
  "Move to…" menu; ⌘K palette shares `/api/search`.
- Projects & sandboxes (0004, Phases A–D + Path B shipped): `projects`
  (1+ git repos) reference shareable `sandbox_configs`; git credentials
  resolve by host through the pluggable `GitHost` seam (`lib/git-hosts/`
  — github + forgejo, `installAuth` + `createPR`). Conversations bind to
  a project at creation (the plain `project_id` column,
  set by the chat route on first send). Sandbox bindings (0013): a
  conversation's sandbox is chosen once, by the send that creates it —
  its own (created lazily on the first sandboxed call through the 0010
  lease seam, repos cloned into `/work/<conversationId>`), none, or
  attached (a copy of the owner's binding: same sandbox AND same
  workDir). The binding lives in `conversations.sandbox_id` /
  `sandbox_work_dir` / `sandbox_owner` / `sandbox_disabled`
  (`getConversationBinding`/`bindConversation` in `db/sandboxes.ts`);
  tools open it with `openConversationSandbox`/`openSandbox`
  (`lib/sandboxes/binding.ts`), which never stop or destroy. A bound
  conversation never switches sandboxes — start a new chat. A
  project's sandboxes run its sandbox config's `image_ref` (a project
  with no config uses `default`; unset = `localhost/sweatshop-sandbox`,
  built from `Containerfile.sandbox`); `network_policy` is recorded,
  not enforced. Post-mortems from outside (0013 phase 6): every chat
  has `inspect` (read-only status / transcript tail / harness activity
  / binding / call attribution of a chat, run, or stage visit) and
  `sandbox_exec` (one command in a named sandbox, in its owner's
  workDir, without binding the caller; resumes a stopped one, never
  stops or destroys) — `lib/agent/tools/inspect.ts`.
  Entities
  are managed db-first via `npm run db:seed` (secrets from env only);
  `/p/[projectId]` starts a project conversation; `create_pr` is the
  agent's PR tool.
- Machines (0009): user-editable stage machines — sqlite `machines`
  rows holding a zod-validated JSON definition (`lib/machines/
  definition.ts`; seeds in `lib/machines/seeds/*.json`, insert-only via
  `npm run db:seed`); runs snapshot it (`machine_runs`,
  `machine_stage_runs`, store `db/machines.ts`). `runMachine`
  (`workflows/machines/`) is a raw Workflow SDK interpreter — no agent
  session. Stage kinds: `harness` (pi/claude HarnessAgent, one
  `"use step"` per semantic agent step via `@ai-sdk/workflow-harness`
  `runHarnessAgentStep` + `stopWhen: isStepCount(1)`; project machines
  only), `agent`
  (0010 Phase 5: an in-process WorkflowAgent turn — `agentStageStep`,
  one `"use step"` per visit, persisted as a conversation under the
  stage session id; branching stages choose via a side-effect-free
  `transition` tool, single-target ones advance on completion; was
  `eve` in 0009), `human` (a `defineHook`
  gate shown in `/inbox`). A project run has ONE sandbox binding
  (0013, `machine_runs.sandbox_id`/`sandbox_work_dir`/`sandbox_owner`):
  inherited from the chat that started it via `start_machine` (same
  sandbox and directory; `fresh: true` opts out), or its own dedicated
  lease provisioned at start through the 0010 seam (`acquireSandbox`,
  `lib/sandboxes/lease.ts`; `SandboxProvider` in `provider.ts`,
  podman today/VMs later; rows in `sandboxes`) whose repos clone to
  `/work/<runId>` — never `/workspace`: pi runs
  in-process and treats a sandbox workdir that also exists on the host
  as shared, and the dev runtime's `/workspace` is this repo. Every
  harness stage, and every agent stage (which gets bash/pi/claude),
  works in that checkout. The sandbox outlives the run (finished or
  cancelled work stays inspectable/attachable). One reaper
  (`lib/sandboxes/reaper.ts`) stops/destroys idle sandboxes — runs 10
  min / 3 days, chats 30 min / 14 days (`GC_*` env), never one with
  live work in it — and MARKS rows destroyed, never deletes them. It
  runs on a timer from `instrumentation.ts` (every 5 min while the
  server is up; `SANDBOX_REAPER=off` disables), from "Run cleanup now"
  on `/sandboxes`, and via `./dev exec -- npm run sandbox:gc` (a client
  of `POST /api/sandboxes/reap`; `GC_APPLY=1` to act). Each sandbox
  page has manual Stop / Destroy. Purging a run destroys the sandbox it
  owns. An inherited binding is never
  released by the run. Branching agent stages pick a
  target with a `transition` tool; the interpreter validates and commits
  it. Runs are conversations (0012): `createRun` writes a
  `conversations` row with `kind = 'run'` and the SAME id as the run
  (`mr_…`), so runs live in the sidebar beside chats (folders, archive,
  trash, search, dots); `machine_runs` stays the source of truth for
  status/visits. Agent-stage visit conversations are `kind = 'stage'`
  (`<runId>_<seq>`) — hidden from sidebar/unread/search, whose body
  hits report the parent run. Run unread = `machine_runs.settled_at`
  (stamped on waiting/needs-attention/completed/failed) newer than
  `last_seen_at`; a waiting gate puts needs-you on the run row.
  `lib/machines/runs.ts` is the one start/cancel path (`startRun`
  records `workflow_run_id`; `cancelRun` cancels the workflow, marks
  the run cancelled — final, later status writes are ignored; the
  sandbox stays); trashing a live run cancels it, purge removes the run
  and its visit sessions (and destroys its own sandbox). Triggers: the fresh composer's
  target picker (`?machine=<id>` preselects; `/` and `/p/<id>`), Run
  on `/machines/<id>`, ⌘K "Run …", `POST /api/machine-runs`, the
  `start_machine` chat tool; `/r/<runId>` is the run view (visit
  transcripts open in a side panel; `/c/<runId>` redirects there).
  Links go through `conversationHref`. Machine graph (0014):
  `/machines/<id>` is a graph editor (`@xyflow/react` 12.12.0, pinned;
  AI Elements canvas/controls/panel) over ONE draft definition — every
  change is a pure op in `lib/machines/edit.ts` (also the 0015 agent
  tools' surface through `applyOps`/`editOpSchema`), re-validated by
  `parseDefinition`, with issues placed on nodes/edges via
  `issuesByElement`; a JSON tab edits the same draft. The editor polls
  its machine's version every 5 s while visible (0015): newer + clean
  draft reloads silently; newer + unsaved edits shows a stale banner
  (`components/machines/use-machine-version-sync.ts`). Layout is automatic and never stored
  (`lib/machines/layout.ts`, layered, loops as back edges; left→right or
  top→bottom, auto-picked from the canvas size by `pickDirection`; the editor's
  inspector exists only while something is selected — right dock when wide,
  bottom sheet when the editor body is under 760px); the run
  view shows the run's snapshot with a progress overlay. Graph modules
  are client-only (`machine-graph-lazy.tsx`, `ssr: false`). Everything runs in the Next
  process — no cross-runtime HTTP. Workflow-transform rule: Node-touching code only inside `"use step"`
  functions, and the workflow body imports harness packages type-only
  (a runtime import drags pi's raw-.ts deps into the bundle). Harness
  packages are `serverExternalPackages` in next.config. Keep
  `@ai-sdk/workflow` aligned with the installed `ai` line (2.0.53 ↔
  ai 7.0.122 / provider-utils 5.0.51), and `@ai-sdk/workflow-harness`
  exactly on the harness line (1.0.132; its stale `workflow@4` peer is
  satisfied by a scoped npm override). These pins are exact in
  package.json on purpose — a caret range would let a routine install
  break a load-bearing pairing; bump them deliberately, together.
- Agent everywhere (0015): every chat has machine tools —
  `list_machines`, `get_machine`, `create_machine` (full definition),
  `edit_machine` (a batch of `edit.ts` ops applied in order,
  all-or-nothing against `baseVersion`; an invalid batch returns issues
  by stage/transition plus the draft shape and saves nothing, a stale
  `baseVersion` is a conflict) and `delete_machine` (asks through the
  ask_chad hook) — cores in `lib/agent/tools/machines.ts`, errors
  value-shaped so the model repairs them. Page context: pages register
  what they are (`components/page-context.tsx` provider in the root
  layout; `usePageContext`; the machine editor includes its selection,
  the run view its status) and a panel send carries it as a
  "[viewing]" note — a user-role message injected before the send (the
  agent forbids system messages in `messages`), stored as
  `messages.metadata` (never text), rebuilt each turn
  (`listTurnMessages`), shown as a transcript chip. The agent panel
  (`components/agent-panel.tsx`, in the root layout) is an ordinary
  ChatSession (`components/chat-session.tsx` — the frame-independent
  transcript/composer/transport the page frame `components/chat.tsx`
  shares) in a right-side frame: floating bottom-right toggle + ⌘J,
  pushes the page on lg+ / overlays below / full-screen under md,
  resizable; one current conversation in localStorage, New / Open full
  page; binds to the page's project at the creating send and never
  switches (0013); marks seen while open. The session instance is never
  remounted on adoption — the transport's mid-turn reconnect only works
  while its useChat instance lives, so the session self-adopts (same
  id) and the panel re-mounts only for New or a reopened stored
  conversation (hydrated before mount; initialMessages/activeRunId are
  init-only props).
- Harness agents (0005/0006 + 0010 Phase 3): project conversations
  have `pi` and `claude` tools — separate coding harnesses on the
  conversation's sandbox (0010 lease seam; `harnessToolStep` in
  `workflows/chat/harness-step.ts` is ONE `"use step"` per tool call:
  acquire sandbox, claim the one-run-per-sandbox slot, advance the
  harness turn by semantic steps via `runHarnessAgentStep` +
  `isStepCount(1)`; cross-call continuity is durable — the terminal
  state's `resumeFrom` handle persists in `chat_harness_state` and
  seeds the next call). pi (`@ai-sdk/harness-pi`) runs in-process on
  GLM via the Z.AI coding plan's Anthropic Messages surface
  (`https://api.z.ai/api/anthropic`), through the shared AI SDK adapter
  (`toSandboxSession`). claude (`@ai-sdk/harness-claude-code`, pinned
  exactly 1.0.136) runs the official Agent SDK as an in-sandbox bridge
  process reached over the private `sweatshop-harness` podman network
  (host processes have no route to podman bridge subnets — membership
  is the boundary, never a published LAN port). claude auth (0006
  amendment): a claude setup-token passed as `CLAUDE_CODE_OAUTH_TOKEN`
  through the adapter's env channel (`auth: "direct"` — no gateway, no
  host discovery); single-user personal use per Chad's recorded
  decision, revisit if productized. The tool is env-gated off until the
  variable is set. Harness activity persists in `harness_events` +
  `harness_runs` keyed (conversation, harness) —
  `/h/<harness>/<conversationId>` is the one shape for every harness
  (pi, claude); legacy `/h/<id>` and `/h/<id>/<harness>` URLs
  permanent-redirect. Failures record as failed with a clipped error,
  events page by id cursor. Packaging pins:
  `pi-coding-agent` exactly 0.85.1; harness-pi 1.0.134 / harness
  1.0.132 / harness-claude-code 1.0.136. Adapter rules: env goes as
  `docker exec -e` flags, exec uses `bash` not `sh`, and bridge
  processes need the real streaming spawn (run-to-completion replay
  cannot host one). Opt-in spike:
  `CLAUDE_SPIKE=1 npx vitest run tests/claude-spike.integration.test.ts`
  (+ `CLAUDE_SPIKE_LIVE=1` with `CLAUDE_CODE_OAUTH_TOKEN` set for a
  bounded turn).

- Previews (0016): a preview is a long-running HTTP server in a
  sandbox, owned by the SANDBOX (outlives the turn/run/stage that
  started it). Registry `previews` (+ `preview_events` follow history),
  store `db/previews.ts`, lifecycle `lib/previews/service.ts` (the one
  start/stop/reconcile path, through `SandboxHandle.run` and the
  `PreviewNetwork` seam). Processes run DETACHED in the sandbox
  (`setsid nohup`, pid/log under `/work/.previews/`), so Next/`./dev`
  restarts never kill them. Reached at `https://pv-<slug>.internal.crussell.io`:
  bees' Caddy (`hosts/bees/caddy/routes/internal/previews.caddy` in cn)
  → bee `10.10.0.12:3301` (published by `./dev`) → the hand-rolled
  node:http Host-routing proxy (`lib/previews/proxy.ts`, WebSocket
  upgrades spliced at TCP — HMR works; not a Next route) → the sandbox
  container by name on `sweatshop-harness`. Node-only background work
  (reaper, proxy, 30 s tick) starts from `instrumentation-node.ts`
  (`instrumentation.ts` only imports it under NEXT_RUNTIME=nodejs — keeps
  sqlite out of the edge bundle). Tools `start_preview` /
  `preview_status` / `stop_preview` come with any sandbox (chats and
  agent stages; definitions in `workflows/chat/preview-tools.ts`, cores
  in `lib/agent/tools/previews.ts`, value-shaped errors); start is
  idempotent per (sandbox, dir, port) and injects PORT / HOST /
  PREVIEW_HOST / PREVIEW_URL; defaults come from the project's saved
  setup (0017), else `describeDir` prefills once. Branch previews
  (`lib/previews/branch.ts`): `/previews` → New preview is TWO-PHASE
  (0017 phase 1): provision (the row is inserted BEFORE the sandbox —
  a `provisioning` status; failures land as visible `failed` rows with
  the reason, never invisible 500s) → discover (scan the checkout for
  packages with dev/start scripts — `lib/previews/discover.ts`; no
  per-launch inference anywhere) → confirm (values + optional setup
  save, `install` at the repo root SEPARATE from the server command,
  launch). A project with a saved `preview_setups` row (zod definition,
  `db/preview-setups.ts`) skips discovery — create is one shot. The
  dedicated sandbox (owner kind `preview`, owner id = preview id) then
  runs a deterministic FOLLOWER (in the tick): fetch → ff (hard reset
  on force-push) → reinstall from the setup's `install` + restart only
  on dependency changes → else trust HMR; a failure parks the
  preview `failed` at that sha (it keeps serving the last good commit)
  and raises a needs-you Inbox card (Fix it = a chat ATTACHED to the
  preview's sandbox, seeded with the failure, started via
  `lib/chat/start-turn.ts`; Retry — a create-time failure re-provisions
  from scratch; Dismiss per sha). Abandoned `provisioning` rows age to
  `failed` after 30 min (the tick). Surfaces: header
  pill on chat/run/panel, transcript card, sandbox-page Previews
  section, `/previews`, ⌘K "Open preview". Reaper: a
  provisioning/starting/healthy
  preview makes its sandbox busy; previews idle past
  `GC_PREVIEW_STOP_HOURS` (12) are stopped; preview-owned sandboxes use
  `GC_PREVIEW_DESTROY_DAYS` (7). LAN/Nebula only — no auth, never route
  publicly.

- Inbox & attention (0008, no design doc — approved in chat): `/inbox`
  is a dashboard of what is waiting on Chad. **Needs you** = pending
  human-input requests (tool approval / question / session-limit) plus
  machine runs waiting at a human stage (0009); stays until answered, opening the
  thread does not clear it. **Unread** = assistant output newer than
  `conversations.last_seen_at`; opening a conversation marks it seen
  (`lib/use-mark-seen.ts`: only while the tab is visible AND focused),
  per-item mark read/unread via `PUT /api/conversations/[id]/seen`.
  New-runtime pending requests are rows (`pending_inputs`, written by
  ask_chad through a step, resolved by `/api/x/input`); eve-era requests
  are still derived from the retired mirror's events (`db/attention.ts`
  folds both, `runtime` routes each card's endpoint). Cards
  (`components/inbox/`: approval / question / machine-gate / unread)
  answer new-runtime approvals by POSTing to `/api/x/input`.
  The sidebar shows the same signal as dots (amber = needs you, filled =
  unread) on rows, rolled up on collapsed folders/groups, kept live by
  `lib/use-attention-sync.ts`: while the tab is visible it polls
  `GET /api/attention` every 5s and `router.refresh()`es only when the
  attention signature differs from the one the layout rendered. The tab-title
  flash and system notifications were deliberately removed — dots only.

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
  container 3000, plus the 0016 preview proxy on 10.10.0.12:3301 →
  container 3001 (`PREVIEW_PUBLISH` overrides). When the host rootless podman socket exists it is
  mounted at `/var/run/docker.sock`, so the sandbox provider creates
  lease containers as siblings on host podman. `./dev` also ensures a
  private `sweatshop-harness` podman network and puts every invocation
  on it (0006 — claude bridge connectivity).
- Agent shells must run podman under escalated (full-access) file
  permissions — podman writes runtime state under `/run`.
- Workflow SDK docs are vendored at `docs/workflows/` — read and grep
  them on the host (also `node_modules/ai/docs` for the AI SDK).

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
