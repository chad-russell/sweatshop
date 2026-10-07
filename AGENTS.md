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

- **Branch / remote:** `origin` is `chad/sweatshop` on Forgejo
  (git.crussell.io, pushed as the `glen` account; this checkout's
  `core.sshCommand` selects the key). `main` is this repo; the
  prototype's history lives on as `archive/prototype` + its `v0.*` tags.
  Agents work on branches and open PRs; Chad merges; `scripts/deploy.sh`
  ships merged `main`.
- **Commits:** conventional commits — `type(scope): subject` (feat, fix,
  docs, chore, refactor…). Commit often enough that history reads as a
  logical sequence of small steps.
- **Process (hybrid by size):** small or mechanical changes go straight to
  commits. Anything architectural — new subsystem, dependency decision,
  layout change, anything that sets precedent — gets a numbered design doc
  under `docs/` (`docs/NNNN-slug.md`) approved by Chad before
  implementation starts.
- **Quality bar:** `npm run typecheck`, `npm run lint`, and `npm run test`
  pass before every commit (run inside the container via `./dev exec` — see Environment).
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
  ONE durable stream per turn: slices stream with `preventClose` +
  `sendFinish: false` and `finishTurnStream` emits the single `finish`
  and closes it AFTER `persistTurn` (the default closes after the first
  slice — the browser then saw one slice of a long turn). A fresh page
  stays on `/` while its creating turn is live and moves to `/c/<id>`
  only once it settles (`onAddressable`): a refresh on `/c/<id>` renders
  the conversation page and remounts the session mid-turn.
  sqlite is the source of truth (`messages.model_message` rows); the
  browser uses `useChat` + `WorkflowChatTransport` against
  `/api/x/chat/*` (client imports MUST come from
  `@ai-sdk/workflow/client` — the main entry pulls server modules into
  the browser bundle). Approvals are `defineHook` suspensions answered
  via `/api/x/input`; the model instance crosses step boundaries through
  `SerializableChatModel` (@workflow/serde class protocol).
- Wakes (0022): when a child settles — a machine run
  (waiting/needs-attention/completed/failed) or a background harness
  call (completed/failed) — the chat that started it is nudged through
  exactly the path a human send takes (`lib/chat/wake.ts`): mid-turn
  the message queues as steer, idle `startChatTurn` starts a turn. The
  wake is a user row with `metadata.runEvent`, rendered as a transcript
  chip, never as Chad's words. Idempotency is `woken_settled_at`
  (stamped after delivery — duplicates over losses); the 30 s sweep in
  `instrumentation-node.ts` re-fires anything the in-run wake missed
  (`WAKE_SWEEP=off` disables). Cancelled children never wake; trashed
  parents are marked woken and skipped. `cancel_run` (agent tool)
  stops `mr_…` runs and `hc_…` calls, keeping sandboxes and work.
  Transcript cards show the child's live status: `GET /api/x/status/<id>`
  (`lib/child-status.ts`, both kinds) polled by `useChildStatus` every
  5 s while the child is live and the tab visible, never once settled.
- UI is Vercel AI Elements on shadcn + tailwind. The visual system is the
  `DESIGN.md` token contract: semantic tokens only, never raw hex/oklch in
  TSX; themes `clickhouse` (default), `cal`, `nova`.
- Models: providers and routes (0021). Providers are code, keys are
  env: `lib/providers/registry.ts` — GLM (Z.AI coding plan via
  `zhipu-ai-provider`, OpenAI surface for chats, Anthropic surface for
  pi; `ZAI_API_KEY`), Gloo and OpenRouter (`@ai-sdk/openai-compatible`
  3.0.59, exact pin; `GLOO_API_KEY`, `OPENROUTER_API_KEY`). A provider
  without a key is unavailable (hidden, rejected at validation). Gloo
  422s a tool without a `description`: the chat path fills it
  (`fillToolDescriptions`, `transformRequestBody`); harness-pi already
  describes host tools. Catalogs: GLM/Gloo static
  (`lib/providers/catalog.ts`), OpenRouter fetched + cached in
  `provider_models` (tool-capable only, ≤ daily, "Refresh models" on
  `/settings`). One ROUTE value (`lib/providers/route.ts`, pure zod):
  `{provider, model}` for chats/agent stages/titles, `{harness:"pi",
  provider, model, thinking?}`, `{harness:"claude", model?, effort?}` —
  claude has nowhere to put a provider (subscription-only, ToS by
  construction). Resolution per surface (`resolveRoute`): chat =
  conversation > project > global; agent = run-stage > run > stage >
  project > global; pi = run-stage > run > stage > conversation >
  project > global; claude = run-stage > stage > global (never inherits
  a chat/project route); titles = the titles default, else the
  project's default when the project forbids it, else skipped. Project
  restrictions (`projects.allowed_providers` / `allowed_harnesses`,
  null = all) apply AFTER resolution at every layer — rejected, never
  swapped. `lib/providers/resolve.ts` (`checkRoute` / `requireRoute`,
  Node-only) is the one resolver; steps throw a FatalError (no retries)
  on a route that cannot run. Storage: `conversations.route`,
  `projects.default_route`, the `settings` table (per-surface global
  defaults; built-ins = GLM `glm-5.3-flash`, claude subscription
  default), machine stage `route` (replaced harness `model`/`thinking`
  and agent `model`; `set_route` edit op), `machine_runs.overrides`
  (`startRun({overrides})`, API, `start_machine`; validated at start).
  What ran is recorded: `machine_stage_runs.route` ({route, layer}) and
  the turn's first assistant row's `metadata.route`. Write paths shared
  by UI and future tools live in `lib/providers/settings.ts`. Surfaces:
  the chat's route picker (`components/route-picker.tsx`, per
  conversation, not sticky), `/settings`, the project page Models
  card, the run view's per-visit route. Live check:
  `PI_SPIKE=1` (pi on every keyed provider via the real builder) and
  `CLAUDE_SPIKE=1 CLAUDE_SPIKE_LIVE=1` (claude on a route).
- Auth: LAN-only personal tool with no auth layer. **Hard rule: add a
  real verifier before any internet exposure.**
- Persistence north star: SQLite (single db, or split where it makes
  sense) + S3 object storage. **No postgres and no other backends — ever.**
- The app store lives in `data/sweatshop.db` (better-sqlite3 + drizzle,
  migrations in `drizzle/`, apply with `npm run db:migrate`): a
  `conversations` index; chat history as `messages` rows carrying a
  serialized ModelMessage (`db/chat.ts`, plus `steer_queue`,
  `conversations.active_run_id`); background harness calls
  (`harness_calls`, `db/harness-calls.ts`, 0022); and the sandbox lease
  registry (`sandboxes` + `sandbox_attachments`, `db/sandboxes.ts`). The eve-era
  `conversation_events` mirror is GONE (0010 Phase 6 retired it; 0032
  dropped the table, `db/mirror.ts`, and the one-time importers —
  history in docs/0010 and docs/0032; 0002's dual-write invariants are
  historical). Eve-era transcripts live on in `messages` (imported
  before the importer was deleted).
- Conversation organization (0007): per-group (project, or Chats) folder
  trees (`folders`, `conversations.folder_id`), an "Unfiled" list per
  group split by age, archive (searchable) and trash (30-day lazy
  purge, not searchable), manual rename pinned via `title_source`, and
  generated title+summary (`lib/titles.ts`, the 0021 `titles` route, fired from the
  chat turn after persisting, max two calls per conversation). All invariants live in
  `db/organize.ts`; routes under `app/api/{folders,conversations}`; the
  sidebar is `components/sidebar/*` with native drag and drop plus a
  "Move to…" menu; ⌘K palette shares `/api/search`.
- Projects & sandboxes (0004, Phases A–D + Path B shipped; 0031
  simplifications): `projects` (1+ git repos) carry their sandbox image
  directly (`projects.image_ref`; unset = `localhost/sweatshop-sandbox`,
  built from `Containerfile.sandbox` — the shareable `sandbox_configs`
  entity and the recorded-not-enforced `network_policy` are gone); git
  credentials resolve by host through the pluggable `GitHost` seam
  (`lib/git-hosts/` — github + forgejo, `installAuth` + `createPR`).
  Conversations bind to a project at creation (the plain `project_id`
  column, set by the chat route on first send). Sandbox bindings (0013):
  a conversation's sandbox is chosen once, by the send that creates it —
  its own (created lazily on the first sandboxed call through the 0010
  lease seam, repos cloned into `/work/<conversationId>`), none, or
  attached (a copy of the owner's binding: same sandbox AND same
  workDir). The binding lives in `conversations.sandbox_id` /
  `sandbox_work_dir` / `sandbox_owner` / `sandbox_disabled`
  (`getConversationBinding`/`bindConversation` in `db/sandboxes.ts`);
  tools open it with `openConversationSandbox`/`openSandbox`
  (`lib/sandboxes/binding.ts`), which never stop or destroy. A bound
  conversation never switches sandboxes — start a new chat. The BINDING
  is the record of where a conversation's calls ran (0031 dropped 0011's
  per-call `sandbox_calls` attribution). Post-mortems from outside
  (0013 phase 6): every chat has `inspect` (read-only status /
  transcript tail / harness activity / binding of a chat, run, or stage
  visit) and `sandbox_exec` (one command in a named sandbox, in its
  owner's workDir, without binding the caller; resumes a stopped one,
  never stops or destroys) — `lib/agent/tools/inspect.ts`.
  Entities are managed on the project page (0018 phase 3 + 0031: rename,
  repos with guarded removal, the sandbox image field, and
  delete-project — the approved cascade: cancel live runs, destroy live
  sandboxes, then every project-owned row, conversations hard-deleted
  via `deleteConversationForever`; machines and credentials untouched);
  `/p/[projectId]` is the PROJECT PAGE (0018: repos + resolved git
  hosts, sandbox image, preview-setup editor, work-surface links) and
  project conversations start on `/` with `?project=<id>`; `create_pr`
  is the agent's PR tool.
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
  (`lib/sandboxes/reaper.ts`) stops/destroys idle sandboxes — ONE
  window since 0031 (stop 30 min, destroy 7 days; `GC_STOP_MINUTES` /
  `GC_DESTROY_DAYS` env), never one with
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
  and its visit sessions (and destroys its own sandbox). 0022: a run
  started by `start_machine` records its parent
  (`machine_runs.parent_conversation_id`; UI/API starts have none) and
  its settle steps (`markRun`, `beginVisit`'s human-gate waiting) wake
  that chat — see the Wakes bullet. Triggers: the fresh composer's
  target picker (`?machine=<id>` and `?project=<id>` preselect; `/`,
  0018), Run
  on `/machines/<id>`, ⌘K "Run …", `POST /api/machine-runs`, the
  `start_machine` chat tool; `/r/<runId>` is the run view (visit
  transcripts open in a side panel; `/c/<runId>` redirects there).
  Links go through `conversationHref`. Machine graph (0014 → 0031):
  `/machines/<id>` shows ONE draft definition as a READ-ONLY canvas
  (`@xyflow/react` 12.12.0, pinned; AI Elements canvas/controls) plus a
  JSON tab that edits it — canvas editing, drag-connect, and the
  inspector are gone (0031; the agent's `edit_machine` ops in
  `lib/machines/edit.ts`, applied through `applyOps`/`editOpSchema`,
  are the structured edit surface), re-validated by `parseDefinition`,
  with issues placed on nodes/edges via
  `issuesByElement`. Selection is observational (the page's
  "[viewing]" context). The editor polls
  its machine's version every 5 s while visible (0015): newer + clean
  draft reloads silently; newer + unsaved edits shows a stale banner
  (`components/machines/use-machine-version-sync.ts`). Layout is automatic and never stored
  (`lib/machines/layout.ts`, layered, loops as back edges; left→right or
  top→bottom, auto-picked from the canvas size by `pickDirection`); the run
  view shows the run's snapshot with a progress overlay. Graph modules
  are client-only (`machine-graph-lazy.tsx`, `ssr: false`). Everything runs in the Next
  process — no cross-runtime HTTP. Workflow-transform rule: Node-touching code only inside `"use step"`
  functions, and the workflow body imports harness packages type-only
  (a runtime import drags pi's raw-.ts deps into the bundle). Harness
  packages are `serverExternalPackages` in next.config. Keep
  `@ai-sdk/workflow` aligned with the installed `ai` line (2.0.62 ↔
  ai 7.0.130 / provider-utils 5.0.56), and `@ai-sdk/workflow-harness`
  exactly on the harness line (1.0.141; its stale `workflow@4` peer is
  satisfied by a scoped npm override). These pins are exact in
  package.json on purpose — a caret range would let a routine install
  break a load-bearing pairing; bump them deliberately, together.
- Agent everywhere (0015): every chat has machine tools —
  `list_machines`, `get_machine`, `create_machine` (full definition;
  validated, then approval-gated through the ask_chad hook — machines
  are reusable pipelines, never a workaround),
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
- Harness agents (0005/0006 + 0010 Phase 3 + 0022): project
  conversations have `pi` and `claude` tools — separate coding harnesses
  on the conversation's sandbox (0010 lease seam). CHAT calls are
  BACKGROUND work (0022 cut 2): the tool step
  (`startHarnessCallStep` → core `lib/chat/harness-call-start.ts`)
  validates the route (0021 resolution), claims the one-per-session
  slot, inserts a `harness_calls` row (`hc_…`, store
  `db/harness-calls.ts`), and starts ONE `harnessCall` workflow
  (`workflows/chat/harness-call.ts`) — the tool returns the handle
  immediately (value-shaped errors: no-project / not-configured /
  busy / start-failed). The worker advances the harness turn ONE
  semantic step per `"use step"` (`harnessAdvanceStep` — sandbox,
  sink into `harness_events`, `runHarnessAgentStep` + the shared
  harness-agent builder) and settles via `harnessSettleStep`: persist
  the `resumeFrom` handle (natural completion only — cross-call
  continuity stays durable in `chat_harness_state`), settle the row,
  release the slot, and WAKE the conversation with the clipped final
  text (0022 cut 1's primitive). The slot is held for the call's whole
  life — a second call errors busy, and the running row is what keeps
  the sandbox in the reaper's busy set. Cancelling (`cancel_run` with
  the `hc_…` id) cancels the workflow, settles the row cancelled (no
  wake), releases the slot; settles are running-only writes so the
  first final write wins. AGENT-STAGE pi/claude calls (inside machine
  runs) stay SYNCHRONOUS — `harnessToolStep` (same file) is one
  `"use step"` per tool call advancing to completion in the run's
  inherited binding; a run's stage is already async from every chat.
  pi (`@ai-sdk/harness-pi`) runs in-process on
  GLM via the Z.AI coding plan's Anthropic Messages surface
  (`https://api.z.ai/api/anthropic`), through the shared AI SDK adapter
  (`toSandboxSession`). claude (`@ai-sdk/harness-claude-code`, pinned
  exactly 1.0.145) runs the official Agent SDK as an in-sandbox bridge
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
  `pi-coding-agent` exactly 0.85.1; harness-pi 1.0.143 / harness
  1.0.141 / harness-claude-code 1.0.145 (the 1.1 stack bump: harness
  1.0.141 pins provider-utils 5.0.56 / ai 7.0.130 exactly, so the ai /
  workflow / provider-utils line moves with it — one deliberate bump). Adapter rules: env goes as
  `docker exec -e` flags, exec uses `bash` not `sh`, and bridge
  processes need the real streaming spawn (run-to-completion replay
  cannot host one). Opt-in spike:
  `CLAUDE_SPIKE=1 npx vitest run tests/claude-spike.integration.test.ts`
  (+ `CLAUDE_SPIKE_LIVE=1` with `CLAUDE_CODE_OAUTH_TOKEN` set for a
  bounded turn). Other opt-in live tests (skipped in the normal gate;
  the env var must be set INSIDE the container):
  `./dev exec -- sh -c 'PREVIEW_E2E=1 npx vitest run tests/preview-first-fill.integration.test.ts'`
  (0019: the New-preview first-fill path on real podman + a git-daemon
  upstream), `SERVICES_SPIKE=1` (0017 services substrate).

- Previews (0016): a preview is a long-running HTTP server in a
  sandbox, owned by the SANDBOX (outlives the turn/run/stage that
  started it). Registry `previews` (+ `preview_events` follow history),
  store `db/previews.ts`, lifecycle `lib/previews/service.ts` (the one
  start/stop/reconcile path, through `SandboxHandle.run` and the
  `PreviewNetwork` seam). Processes run DETACHED in the sandbox
  (`setsid nohup`, pid/log under `/work/.previews/`), so Next/`./dev`
  restarts never kill them. Reached at `https://pv-<slug>.internal.crussell.io`:
  bees' Caddy (`hosts/bees/caddy/routes/internal/previews.caddy` in cn)
  → bee `10.10.0.12:3301` (published by the `sweatshop` service) → the hand-rolled
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
  PREVIEW_HOST / PREVIEW_URL; those platform vars are FINAL over the
  layered env (0017 phase 2: project setup env → per-preview sparse
  overrides in `previews.env` → platform; `${PREVIEW_URL}`/`${PREVIEW_HOST}`/
  `${PORT}`/`${HOST}` interpolate at launch, `${service:…}` waits for
  phase 3; the resolved set is also written to
  `/work/.previews/<id>.env`, 0600); defaults come from the project's saved
  setup (0017), else `describeDir` prefills once; agent tools also
  include `get_preview_setup` / `save_preview_setup`. Declared
  SERVICES (0017 phase 3, `sandbox_services` rows +
  `lib/sandboxes/services.ts` behind a DockerRunner seam): sibling
  containers on `sweatshop-harness` named `<ref>-svc-<name>` (compose
  semantics — `command` is entrypoint argv; liveness by
  `inspect {{.State.Running}}`, recreate-if-gone), owned by the
  sandbox, ensured at branch provisioning and every launch, readiness
  probed FROM INSIDE the sandbox, `${service:<name>:<port>}` resolving
  to the container name; the setup's `migrate` (schema/migrations; was
  `provision`, renamed 0019) runs once per sandbox (`sandboxes.migrated_at`) after
  services are healthy and before the server, with the resolved env,
  then `seed` (data, 0017 amendment — one command, idempotent by
  convention, same three archetypes: bundled / fetch / dump-restore)
  once per sandbox (`sandboxes.seeded_at`, an independent marker);
  they stop and resume with the sandbox (0019: the reaper's idle-stop
  and manual Stop run `stopSandboxServices` — containers kept, rows
  `stopped`; the next `ensureSandboxServices` STARTS the same container
  so a database's data survives) and die with it (destroy); the sandbox
  page shows them; providers
  declare `canRunServices` (portability contract). Branch previews
  (`lib/previews/branch.ts` create flow, `follow.ts` follower + retry/dismiss,
  `context.ts` shared helpers; remote branch listing is
  `lib/git-hosts/branches.ts`): `/previews` → New preview is TWO-PHASE
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
  the shared 0031 window. LAN/Nebula only — no auth, never route
  publicly.

- Inbox & attention (0008, no design doc — approved in chat): `/inbox`
  is a dashboard of what is waiting on Chad. **Needs you** = pending
  human-input requests (tool approval / question) plus
  machine runs waiting at a human stage (0009); stays until answered, opening the
  thread does not clear it. **Unread** = assistant output newer than
  `conversations.last_seen_at`; opening a conversation marks it seen
  (`lib/use-mark-seen.ts`: only while the tab is visible AND focused),
  per-item mark read/unread via `PUT /api/conversations/[id]/seen`.
  Pending requests are rows (`pending_inputs`, written by ask_chad
  through a step, resolved by `/api/x/input`) — the single source since
  0032 retired the eve event fold and the `runtime` card routing. Cards
  (`components/inbox/`: approval / question / machine-gate / unread)
  answer approvals by POSTing to `/api/x/input`.
  The sidebar shows the same signal as dots (amber = needs you, filled =
  unread) on rows, rolled up on collapsed folders/groups, kept live by
  `lib/use-attention-sync.ts`: while the tab is visible it polls
  `GET /api/attention` every 5s and `router.refresh()`es only when the
  attention signature differs from the one the layout rendered. The tab-title
  flash and system notifications were deliberately removed — dots only.

## Environment

Nothing is installed on the host; everything runs in podman. There is
ONE instance (0020) — no dev server, no second checkout:

- **The app** is the `sweatshop` rootless user quadlet on bee (cn
  `hosts/bee/sweatshop.nix`): `next start` of a production build of THIS
  checkout, container name `sweatshop-dev` (kept so the harness-network
  name and `sandbox:gc`'s default URL hold), image
  `localhost/sweatshop-dev`, on http://localhost:3300 (host 3000 is taken)
  plus the 0016 preview proxy on 10.10.0.12:3301. Restart=always, starts
  at boot. Logs: `journalctl --user -u sweatshop` (agent shells need
  `XDG_RUNTIME_DIR=/run/user/1000`).
- **This checkout is the deploy checkout.** It tracks `main` on Forgejo
  (`origin`, chad/sweatshop) and moves ONLY through `scripts/deploy.sh`
  (fast-forward → `data/backups/pre-<sha>.db` snapshot → stop → `npm ci`
  + `next build` + `db:migrate` → start → health check; a failed build
  restores the previous commit). `scripts/deploy.sh <sha>` rolls back. A
  host script on purpose — sandboxed agents cannot redeploy the app.
- **Changing sweatshop** = an ordinary project: a sandboxed chat or
  machine run on the `sweatshop` project opens a PR (`create_pr`); after
  merge, deploy. dsh is the emergency path when a deploy breaks the app.
- **State** is all under `data/` (backed up nightly by bee's restic, plus
  a `VACUUM INTO` snapshot at `data/backups/nightly.db` an hour before):
  `sweatshop.db` (+WAL), `workflow-data/` (the Workflow SDK local world —
  set by `WORKFLOW_LOCAL_DATA_DIR` together with
  `WORKFLOW_TARGET_WORLD=local` — without the latter `withWorkflow()`
  silently overwrites the dir to `.next/workflow-data`, which a build may
  wipe), `backups/`. `node scripts/db-snapshot.mjs <name>` takes a
  consistent online copy.
- `./dev exec -- <cmd>` — one-off command in a container with the app's
  mounts (the gate, migrations against a temp db, scripts). `./dev
  install`, `./dev shell`, `./dev build` (rebuild the image; the service
  uses it too). Container root maps to the host user; `.env.local` via
  `--env-file`; node_modules in the `sweatshop-node-modules` volume,
  SHARED with the running service — never `./dev install` on bee (it
  changes the live app's dependencies under it); dependency changes land
  by PR and `scripts/deploy.sh` runs `npm ci` while the service is stopped. The host rootless podman socket is mounted at
  `/var/run/docker.sock` (sandboxes are sibling containers), and every
  invocation joins the private `sweatshop-harness` network (0006).
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
