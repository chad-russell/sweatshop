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
  Each finished slice is persisted as it lands (0037 run-5 fix:
  `persistTurn` with `{from, final:false}` per slice, then `final` clears
  the active run; row ids `m_<conv>_<skip>_<i>` are deterministic so
  retried steps never duplicate). A reload or a wake attach of a LIVE
  turn hydrates rows only up to that turn's opening `t_…` row
  (`untilLiveTurn`, `lib/chat-ui.ts`) — the stream replay supplies the
  rest. ONE durable stream per turn: slices stream with `preventClose` +
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
- Wakes (0022): when a child settles — a background harness call
  (completed/failed) or a child thread (0037 phase 3) — the chat that
  started it is nudged through
  exactly the path a human send takes (`lib/chat/wake.ts`): mid-turn
  the message queues as steer, idle `startChatTurn` starts a turn. The
  wake is a user row with `metadata.runEvent`, rendered as a transcript
  chip, never as Chad's words. Idempotency is `woken_settled_at`
  (stamped after delivery — duplicates over losses); the 30 s sweep in
  `instrumentation-node.ts` re-fires anything the in-run wake missed
  (`WAKE_SWEEP=off` disables). Cancelled children never wake; trashed
  parents are marked woken and skipped. `cancel_run` (agent tool)
  stops `hc_…` calls and `c_…` child threads, keeping sandboxes and
  work (`mr_…` runs cannot be live since machines were deleted). Transcript cards show the child's live status:
  `GET /api/x/status/<id>` (`lib/child-status.ts`, all three kinds)
  polled by `useChildStatus` every
  5 s while the child is live and the tab visible, never once settled.
- Child threads (0037 phase 3): `start_thread({prompt, skill?,
  fresh?})` — every chat tool — starts a fresh child chat with its own
  context (the review shape) on the parent's project, ATTACHED to the
  parent's sandbox by default (the parent binds first if still pending;
  `fresh: true` provisions its own), running the prompt as its first
  turn. The child records `conversations.parent_conversation_id` and
  wakes the parent when it settles — same primitive, its own
  bookkeeping: `woken_settled_at` is stamped at creation (the creation
  bump is not a settle) and settle = `updated_at` moved past it with no
  live turn, so the wake fires at the turn's end (`wakeParentStep`,
  after the budget decision — a continuing child still reads as
  working) and in the sweep (crash recovery), carrying the child's last
  assistant message (a review's findings). A child that never produced
  output is stamped woken silently.
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
  `{provider, model, thinking?}` for chats/agent stages/titles,
  `{harness:"pi", provider, model, thinking?}`, `{harness:"claude",
  model?, effort?}` — claude has nowhere to put a provider
  (subscription-only, ToS by construction). `thinking` on chat routes
  (0021 amendment) is the pi vocabulary, mapped per family in
  `chatLanguageModel(route)`: GLM `thinking.type` + `reasoningEffort`
  (off = real disable), Gloo/OpenRouter `reasoning_effort` injected via
  transformRequestBody (off = omit); capability-gated by
  `ModelInfo.reasoning` (static catalogs + the `provider_models.reasoning`
  column, from OpenRouter's `supported_parameters`) — rejected at
  validation on models without a knob, never silently sent; pi routes
  exempt (harness-pi owns its knob). Live check `THINKING_SPIKE=1`.
  Resolution per surface (`resolveRoute`): chat =
  conversation > project > global; agent = (stage layers historical, machines gone) project > global;
  pi = conversation > project > global; claude and cursor = global
  (never inherit a chat/project route); titles = the titles default, else the
  project's default when the project forbids it, else skipped. Project
  restrictions (`projects.allowed_providers` / `allowed_harnesses`,
  null = all) apply AFTER resolution at every layer — rejected, never
  swapped. `lib/providers/resolve.ts` (`checkRoute` / `requireRoute`,
  Node-only) is the one resolver; steps throw a FatalError (no retries)
  on a route that cannot run. Storage: `conversations.route`,
  `projects.default_route`, the `settings` table (per-surface global
  defaults; built-ins = GLM `glm-5.3-flash`, claude subscription
  default), the machine-stage `route` column and `machine_runs.overrides` are
  historical (machines deleted, 0037 phase 5) — the schema keeps them,
  nothing writes them.
  What ran is recorded on the turn's first assistant row's
  `metadata.route` ({route, layer}); `machine_stage_runs.route` is
  historical. Write paths shared
  by UI and future tools live in `lib/providers/settings.ts`. Surfaces:
  the chat's route picker (`components/route-picker.tsx`, per
  conversation, not sticky), `/settings`, the project page Models
  card. Live check:
  `PI_SPIKE=1` (pi on every keyed provider via the real builder) and
  `CLAUDE_SPIKE=1 CLAUDE_SPIKE_LIVE=1` (claude on a route).
- Skills (0037's playbooks folded in by 0039): markdown runbooks in
  `skills/<id>/SKILL.md` (front matter `description`, plus `thread: true`
  for one bindable to a conversation; H1 = title; loader `lib/skills.ts`,
  read at call time). A thread runs one via `conversations.skill` —
  chosen by the creating send (the composer's "Chat with a skill"
  picker section, project scope; `?skill=<id>`; the route rejects
  unknown ids before creating anything) or mid-thread by the agent's
  `use_skill` tool. Its body joins the turn instructions and the turn's
  step budget rises from 50 to 400; a thread-skill turn that EXHAUSTS
  the budget continues in a new turn through `startChatTurn` with a
  `runEvent` of kind `budget` (chip, never Chad's words), bounded at 3
  consecutive continuations with no human message between
  (`lib/chat/budget.ts`). Catalog: `ship` (ticket → `create_pr`),
  `ticket` (0037 phase 3; 0041: a PLAN.md reviewed over as many rounds
  as it takes and approved first, then the Ship steps, then a fresh-eyes `start_thread` review with the `review` skill
  before `create_pr`, findings weighed in the PR body) and `review`
  (0037 phase 3: fresh context — inputs are the ticket, the diff and the
  evidence from the parent's prompt; output is severity-ranked findings
  + a verdict; it changes nothing). Skills without `thread: true` are
  reference material for later 2.3 work — never bindable.
- Plan files (0041): a plan is a scratch `PLAN.md` in the conversation's
  work root (`/work/<conv>/`, beside the checkouts — never in a PR),
  written with `bash` like any file and never re-injected into context.
  `present_plan` (sandboxed chats; `workflows/chat/plan-tools.ts`, core
  `lib/agent/tools/plan.ts`) snapshots it into its tool result — that
  result IS the version (count of prior snapshots), the diff base and
  the durable copy — and NEVER suspends. Before approval it opens a
  review: a HOOKLESS `pending_inputs` row of kind `plan` (store
  `db/plans.ts`; card = the snapshot; a newer present supersedes the
  open row, so only the latest waits) that exists only for the Inbox's
  "needs you". `answerPendingWithText` skips plan rows: typing is plan
  discussion, and the model decides what a message is about. Approval
  is explicit only: the plan card's Approve (`/api/x/input`
  `{toolCallId, approvePlan, note?}` — stale/answered versions 409)
  resolves the row and WAKES the conversation (0022 path, runEvent
  kind `plan`, text `[plan vN approved] — …`), or, when Chad approves in
  chat, the agent calls `accept_plan` — itself approval-gated on the
  ask_chad hook with the plan on its card; the card's Approve answers a
  waiting accept_plan directly instead of waking. After approval
  `present_plan` is a progress snapshot (`reapprove: true` reopens
  review). The header PHASE chip (`lib/plan.ts`, pure, derived from
  the transcript, never stored): Plan vN · needs you → Building m/n
  (the plan's `- [ ]` checklist) → PR · needs you → PR open. Quote on
  the plan card drops the selection into the composer as `>` lines.
  The review skill treats `PLAN.md` as the agreed spec. No plan table,
  no hard gate on `create_pr`, mockups are links.
- Web tools (1.5): every chat has `web_search` and `web_fetch`. `web_fetch` is plain HTTP (redirects followed, 2 MiB
  download cap, 60 k character context clip, HTML stripped to text,
  textual content types only); `web_search` is Z.AI's coding-plan MCP
  tool (`web_search_prime`) over hand-rolled streamable-HTTP JSON-RPC —
  no SDK dependency; env-gated on `ZAI_API_KEY`, value-shaped
  not-configured without it.
  Results are value-shaped and framed as untrusted content (tool
  descriptions + one instructions line). Cores
  `lib/agent/tools/web.ts` / `web-search.ts`, steps in
  `workflows/chat/steps.ts`, cards `components/ai-elements/web-cards.tsx`
  on the shared agent-cards shell, views `lib/web-tool-view.ts`.
- Browser & screenshot evidence (0035): `Containerfile.sandbox` bakes
  agent-browser (npm pin) + its Chrome-for-Testing shared libs and
  binary (~/.agent-browser) at build — nothing downloads at runtime; a
  custom `image_ref` without it degrades to agent-checkable
  (`command -v agent-browser`), never a tool gate. Every surface with a
  sandbox (chats; one shared definition,
  `workflows/chat/screenshot-tool.ts`) gets `attach_screenshot`: copy a
  PNG from the sandbox (any path, magic-checked, ≤ 10 MiB) to
  `data/attachments/att_<hex>.png`, served immutably by
  `/api/attachments/[id]` (`ATTACHMENTS_DIR` relocates the root); the
  transcript renders it as an image card (click = full size). Core
  `lib/agent/tools/screenshot.ts`.
- Image attachments (0042): the composer takes images by `+` menu, paste
  or drop (AI Elements prompt-input state; ≤ 4 per message, ≤ 10 MiB,
  PNG/JPEG/WebP/GIF decided by magic bytes, `lib/attachments.ts`).
  `POST /api/x/attachments` stores one at `data/attachments/<id>.<ext>`
  (same root and `att_<hex>` ids as 0035, served by
  `/api/attachments/[id]` for every extension) with an `attachments` row
  (`db/attachments.ts`), UNCLAIMED until a send names it; unclaimed rows
  older than 24 h are swept on the reaper tick (`instrumentation-node.ts`)
  and a conversation's rows + files go with `deleteConversationForever`.
  The browser uploads on send, then the chat message carries `file` parts
  whose url is the serving path; the chat route reads the ids
  (`checkClaimable`), `startChatTurn` passes `attachments`, and
  `recordUserMessage` claims them and stores the user row as
  `[text, {type:"file", data:"attachment:<id>", mediaType}]` — a
  REFERENCE, never bytes (`messages.text` keeps the text). Bytes appear
  only inside `SerializableChatModel.doStream` (a step): it swaps each
  reference for the file's bytes (`workflows/chat/steps.ts`
  `resolveAttachmentPartsStep` → `lib/chat/attachment-parts.ts`), after
  declaring `attachment:` in its `supportedUrls` AND the turn's agent
  passes `experimental_download: async () => nulls` (WorkflowAgent
  hard-codes `supportedUrls: {}` for its first conversion pass; both are
  required or the SDK tries to fetch the scheme). Recorded workflow state
  therefore holds references only (a test decodes it and asserts that).
  No vision gate: images go to whatever model is selected and a model
  that rejects one is the user's error; a missing file becomes the text
  `[image unavailable]`. Steers are text-only (`+` disabled while a turn
  runs; the route 409s an image steer). Reload maps stored parts back to
  UI file parts in `lib/chat-ui.ts`. Mock-model script `images` reports
  what the model received.
- Hosts & the exec tool (0043): a project can list HOSTS — real machines its
  agent may operate on over SSH (table `project_hosts`: name, address,
  user, informational `api_base`, TOFU `host_key_fp`; managed on the
  project page beside repos; the list IS the allow-list, projects
  without hosts get no tool). One tool, `exec(host, command, timeout?)`
  (core `lib/agent/tools/host.ts`, definitions in `workflows/chat/tools.ts`
  with the project's hosts enumerated in the description): approval-gated
  on the ask_chad path (0034 A — validate WITHOUT connecting first, the
  card shows the exact command, typing denies with the text), runs via
  `bash -lc` as the host's user (120 s default / 900 s max; a timeout
  cuts the channel with partial output — the command may still be
  running), 60 k clips per stream, value-shaped failures. Credentials
  resolve from env by host NAME (`HOST_<NAME>_SSH_KEY_FILE` path to a
  0600 key, `HOST_<NAME>_SSH_KEY_PASSPHRASE`, or `HOST_<NAME>_SSH_PASSWORD`
  inline; read at process start, global across projects) — nothing enters
  sqlite, the browser, or any sandbox: the channel is opened by the app
  process over ssh2 (`lib/hosts/transport.ts`, loaded via `createRequire`
  — its native addons cannot enter the workflow bundle), pooled per host,
  host keys TOFU-pinned to the row with mismatch a hard `host-key-changed`.
  Audit: `host_commands` (write-before-run, resolve-after; `host_id` has
  NO FK so history survives host removal), surfaced in `inspect` and the
  terminal `exec` card (host chip + duration). Secrets convention
  (taught in the tool description): reference PATHS never contents; API
  calls run as exec + curl on a host holding the credential file.
  Deferred on purpose: bespoke verbs (deploy/rollback/restart), policy
  modes ("yolo" auto-approve, allowlists, time-boxed grants), a `request`
  tool, per-host kind/runbook fields, network sandboxing. Capability doc
  `docs/agent/hosts.md`; live check `HOST_SPIKE=1` (tests/
  host-spike.integration.test.ts — it found the warm-pool fingerprint
  skip pre-merge).
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
  "Move to…" menu; ⌘K palette shares `/api/search`. Sidebar chrome (0040):
  ACTIONS (New chat, Agent) are buttons, PAGES (Inbox, Projects, then
  Sandboxes and Previews) are `NavRow`s that fill when active
  (`lib/sidebar-nav.ts` maps a pathname to its row; `/p/<id>` lights
  Projects), Archive/Trash hang off the Conversations label's `⋯`, and the
  footer is Settings + the theme cycler. `/projects` is the project index;
  the New-project dialog mounts in the root layout and opens by
  `NEW_PROJECT_EVENT` (the page button and ⌘K both dispatch it).
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
  Entities are managed on the project page (0018 phase 3 + 0031 + 0023:
  rename, repos with guarded removal, the sandbox image field, the work
  defaults — the create_pr card runs the test command, work branches
  take the prefix — and
  delete-project — the approved cascade: destroy live sandboxes, then
  every project-owned row, conversations hard-deleted via
  `deleteConversationForever`; credentials untouched);
  `/p/[projectId]` is the PROJECT PAGE (0018: repos + resolved git
  hosts, sandbox image, work defaults, preview-setup editor,
  work-surface links) and
  project conversations start on `/` with `?project=<id>`; `create_pr`
  is the agent's PR tool — approval-gated EVERYWHERE (0034 A), one
  mechanism per surface: the CHAT tool suspends on the ask_chad hook
  with a commits + diffstat card plus RUNTIME-BUILT evidence (0037
  phase 1, `lib/agent/tools/evidence.ts`: the project's test command
  run by the runtime in the bound sandbox — 900 s cap — and the
  thread's `attach_screenshot` results from `messages`, the LIVE
  turn's own messages (the tool's execute options), and its harness
  calls' `harness_events`), stored as `pending_inputs.card` and
  rendered on the inbox card and inline in the transcript
  (`components/approval-evidence.tsx`). Typing in a thread while it
  waits on Chad ANSWERS the oldest pending input (0037, Chad's
  decision; `lib/chat/answer-pending.ts`, called by the chat send
  route before any steer): an approval resolves DENIED with the text
  as the comment — create_pr returns `changes-requested` and the turn
  continues in the same context — a question takes the text as its
  answer. Approve stays an explicit button. (Machines' `propose_pr`/`publish`
  died with them, 0037 phase 5; harnesses still hold no git write
  powers at all — chat harness calls get no git tool.)
- Machines (0009) — **DELETED 2026-10-10 by 0037 phase 5** (docs/0037,
  evidence runs 8–9 in TRIAL-RUNS: the staged arm couldn't finish
  planning in the time a playbook thread shipped the ticket; its costs —
  context handoffs between amnesiac stages, gates that can only sit
  between stages so a stage can never ASK — are structural). Gone:
  `runMachine`, the stage kinds (harness/agent/human/publish),
  `lib/machines/*` (the shared HarnessAgent builder survives at
  `workflows/chat/harness-agent.ts`), the machine tools + approvals,
  `start_machine`, `/machines` + the graph + `@xyflow/react`,
  the machine-gate inbox card, `pr_proposals` + `propose_pr`/`publish`,
  seeds + `db:seed`. What remains: `machine_runs`/`machine_stage_runs`
  as READ-ONLY history (runs were conversations — sidebar/search/trash
  until purged), `db/machines.ts` reads (getRun/listStageRuns/
  getRunBinding/LIVE_STATUSES), a static `/r/<runId>` view + the run GET
  API, child-status/inspect reads, and the reaper's defensive consult of
  run rows. Migration 0047 dropped `machines` and `pr_proposals`. The
  work surfaces now: a chat running a SKILL (ship/ticket/review), the
  gated tools (`create_pr`), and `start_thread` children — see those
  bullets.
- Agent everywhere (0015; the machine tools died with machines, 0037
  phase 5): every chat has the project tools, gh/forgejo, inspect /
  sandbox_exec, cancel_run, start_thread, web tools and ask_chad, all
  value-shaped so the model repairs its calls. Page context: pages register
  what they are (`components/page-context.tsx` provider in the root
  layout; `usePageContext`; the run view shows its status) and a panel send carries it as a
  "[viewing]" note — a user-role message injected before the send (the
  agent forbids system messages in `messages`), stored as
  `messages.metadata` (never text), rebuilt each turn
  (`listTurnMessages`), shown as a transcript chip. The agent panel
  (`components/agent-panel.tsx`, in the root layout) is an ordinary
  ChatSession (`components/chat-session.tsx` — the frame-independent
  transcript/composer/transport the page frame `components/chat.tsx`
  shares) in a right-side frame: opened by the sidebar's Agent button
  (0040; the floating bottom-right toggle is gone) and toggled with ⌘J,
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
  conversations have `pi`, `claude` and `cursor` tools — separate coding harnesses
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
  first final write wins.
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
  variable is set. cursor (0038, `@ai-sdk/harness-cursor` 1.0.55 over ACP,
  pinned exactly — it pairs with harness 1.0.141) authenticates from the
  CLI's BROWSER-LOGIN `auth.json` (`agent login`), not an API key: the
  app holds it at `data/harness-auth/cursor/auth.json` (0600;
  `HARNESS_AUTH_DIR` relocates; `lib/harness-auth/cursor.ts` is the one
  seam — read/validate/store/plant), and every harness step re-plants the
  host copy into the CLI's private HOME in the sandbox (env-var base64,
  never argv or logs; the host file is the source of truth). The access
  token as `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN` is rejected by the CLI —
  only the file authenticates it. Route `{harness:"cursor", model?}`
  (subscription only, validated against the login: missing/invalid/
  expired refuse value-shaped; a login inside 1 h of expiry is refused),
  `/settings` shows status + expiry. Live check:
  `CURSOR_SPIKE=1 CURSOR_SPIKE_AUTH_JSON=… npx vitest run
  tests/cursor-spike.integration.test.ts` (production builder + plant
  order; `CURSOR_SPIKE_NO_AUTH=1` is the negative control; needs a sandbox
  image with curl until the base image is rebuilt). Harness activity persists in `harness_events` +
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
  `preview_status` / `stop_preview` come with any sandbox (chats;
  definitions in `workflows/chat/preview-tools.ts`, cores
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
  `lib/sandboxes/services.ts` behind a DockerRunner seam): containers
  named `<ref>-svc-<name>` that JOIN THE SANDBOX'S NETWORK NAMESPACE
  (`--network container:<sandbox-ref>`, 0017 amendment 2026-10-10 —
  dev apps' self-URLs like `localhost:9000` just work; the setup schema
  rejects service ports colliding with the server or each other)
  (compose semantics — `command` is entrypoint argv; liveness by
  `inspect {{.State.Running}}`, recreate-if-gone), owned by the
  sandbox, ensured at branch provisioning and every launch, readiness
  probed FROM INSIDE the sandbox, `${service:<name>:<port>}` resolving
  to `localhost:<port>`; the setup's `migrate` (schema/migrations; was
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
  human-input requests (tool approval / question); stays until answered,
  opening the thread does not clear it. **Unread** = assistant output newer than
  `conversations.last_seen_at`; opening a conversation marks it seen
  (`lib/use-mark-seen.ts`: only while the tab is visible AND focused),
  per-item mark read/unread via `PUT /api/conversations/[id]/seen`.
  Pending requests are rows (`pending_inputs`, written by ask_chad
  through a step, resolved by `/api/x/input`) — the single source since
  0032 retired the eve event fold and the `runtime` card routing. Cards
  (`components/inbox/`: approval / question / preview-failure / unread)
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
- **Changing sweatshop** = an ordinary project: a sandboxed chat on
  the `sweatshop` project opens a PR (`create_pr`); after merge,
  deploy. dsh is the emergency path when a deploy breaks the app.
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
