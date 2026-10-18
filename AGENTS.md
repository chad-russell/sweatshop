# AGENTS.md — sweatshop

Instructions for agents working in this repo. Read before doing anything.
Every bullet states the CURRENT contract; the numbered doc in parentheses
(docs/NNNN-*.md) owns the history and the why.

## What this is

sweatshop is a personal software factory: a single Next.js app whose
agent runtime is the Vercel AI SDK (`WorkflowAgent`) on the Workflow SDK
(0010). It uses established tools where possible, preferring build over
buy and libraries from the vercel AI ecosystem where they exist.

It is being built slowly and deliberately from an empty repo — properly
engineered, never vibe-coded. It replaces the prototype at `~/sweatshop`
(see "Old repo policy").

## Ground rules

- **Branch / remote:** `origin` is `chad/sweatshop` on Forgejo
  (git.crussell.io, pushed as the `glen` account; this checkout's
  `core.sshCommand` selects the key). `main` is this repo; the
  prototype's history lives on as `archive/prototype` + its `v0.*` tags.
  Agents work on branches and open PRs; Chad merges; the Forgejo deploy
  workflow (0045) ships merged `main`.
- **Commits:** conventional commits — `type(scope): subject` (feat, fix,
  docs, chore, refactor…). Commit often enough that history reads as a
  logical sequence of small steps.
- **Process (hybrid by size):** small or mechanical changes go straight to
  commits. Anything architectural — new subsystem, dependency decision,
  layout change, anything that sets precedent — gets a numbered design doc
  under `docs/` (`docs/NNNN-slug.md`) approved by Chad before
  implementation starts.
- **Quality bar:** `npm run typecheck`, `npm run lint`, and `npm run test`
  pass before every commit (run inside the container via `./dev exec` —
  see Environment). Store-layer tests run against per-worker temp
  databases; agent-behavior tests use a mock LLM — tests never wait on a
  real model call.
- **No sloppy growth:** prefer deleting over accumulating. Ask before
  adding a dependency. Every file earns its place.

## Architecture (current state)

- Single Next.js (App Router) app at the repo root; `next.config.ts`
  wraps `withWorkflow()` (workflow routes at `/.well-known/workflow/v1`).
- Chat runtime (0010): ONE WorkflowAgent workflow run per turn
  (`workflows/chat/turn.ts`; one model step per slice via
  `stopWhen: isStepCount(1)`, steer messages drain between slices). Each
  finished slice is persisted as it lands (`persistTurn` `{from,
  final:false}` per slice, `final` clears the active run; row ids
  `m_<conv>_<skip>_<i>` are deterministic — retried steps never
  duplicate). A reload or wake-attach of a LIVE turn hydrates rows only
  up to the turn's opening `t_…` row (`untilLiveTurn`,
  `lib/chat-ui.ts`) — the stream replay supplies the rest. ONE durable
  stream per turn (`preventClose` + `sendFinish: false`;
  `finishTurnStream` emits the single `finish` and closes AFTER
  `persistTurn`). A fresh page stays on `/` while its creating turn is
  live, moving to `/c/<id>` only once it settles (`onAddressable`).
  sqlite is the source of truth (`messages.model_message` rows); the
  browser uses `useChat` + `WorkflowChatTransport` against
  `/api/x/chat/*` — client imports MUST come from
  `@ai-sdk/workflow/client` (the main entry pulls server modules into
  the browser bundle). Approvals are `defineHook` suspensions answered
  via `/api/x/input`; the model instance crosses step boundaries through
  `SerializableChatModel` (@workflow/serde class protocol).
- Wakes (0022; full results 0040 phase 3): when a child settles — a
  background harness call (`hc_…`) or a child thread (`c_…`) — the
  parent chat is nudged through exactly the path a human send takes
  (`lib/chat/wake.ts`): mid-turn the message queues as steer, idle
  `startChatTurn` starts a turn. The wake is a user row with
  `metadata.runEvent`, rendered as a transcript chip, never as Chad's
  words. Idempotency is `woken_settled_at` (stamped after delivery —
  duplicates over losses); the 30 s sweep in `instrumentation-node.ts`
  re-fires what the in-run wake missed (`WAKE_SWEEP=off` disables).
  Cancelled children never wake; trashed parents are marked woken and
  skipped. The result is never cut to a stub: a harness call's result
  (`harness_calls.result`) and a thread's `lastAssistantReport`
  (`db/chat.ts` — newest assistant row with real text) are each kept up
  to 60 k chars, the inline detail to `WAKE_DETAIL_CAP = 16_000`, and
  `clipText` ends with a pointer to the saved result file or `inspect`.
  Overflow text is saved best-effort to the PARENT's sandbox at
  `<parentWorkDir>/.sweatshop/results/<id>.md` (`saveResultFile` —
  bound-only, never throws, reports its reason); the path written (or
  null) is persisted at settle time (`harness_calls.result_file` /
  `conversations.result_file`) and `inspect` reads that column verbatim
  — it never derives a path. A harness call's result is its LAST step's
  own text (`resultText`), and every harness task carries the appended
  end-with-a-final-message instruction (`withResultInstruction`,
  `lib/chat/harness-call-start.ts`). A turn that exhausts its budget
  mid-tool-call marks `metadata.exhausted` on its LAST assistant row;
  the wake then reports "ran out of steps" instead of "finished".
- Child threads (0037 phase 3): `start_thread({prompt, skill?, fresh?})`
  — every chat tool — starts a fresh child chat with its own context on
  the parent's project, ATTACHED to the parent's sandbox by default
  (`fresh: true` provisions its own), running the prompt as its first
  turn. The child records `conversations.parent_conversation_id` and
  wakes the parent when it settles (`woken_settled_at` stamped at
  creation; settle = `updated_at` past it with no live turn;
  `wakeParentStep` runs after the budget decision), carrying the child's
  last REAL assistant report; a child with none is stamped woken
  silently. Children get the thread step budget (400, `resolveMaxSteps`)
  even un-skilled (`hasParent`); the budget CONTINUATION is skill-only —
  an un-skilled child that runs out reports once, never re-fires itself.
- UI is Vercel AI Elements on shadcn + tailwind. The visual system is
  the `DESIGN.md` token contract: semantic tokens only, never raw
  hex/oklch in TSX; themes `clickhouse` (default), `cal`, `nova`.
  Components never import `@/db` (lint-enforced); read-model types live
  in `@/lib/read-models` (0049).
- Models: providers and routes (0021). Providers are code, keys are env:
  `lib/providers/registry.ts` — GLM (Z.AI coding plan, `ZAI_API_KEY`),
  Gloo (`GLOO_API_KEY`) and OpenRouter (`OPENROUTER_API_KEY`) via
  `@ai-sdk/openai-compatible` (exactly pinned). A provider without a
  key is unavailable — hidden, rejected at validation. Gloo 422s a tool
  without a `description` (the chat path fills it). Catalogs: GLM/Gloo
  static (`lib/providers/catalog.ts`), OpenRouter fetched + cached in
  `provider_models` (tool-capable only, ≤ daily). One ROUTE value
  (`lib/providers/route.ts`, pure zod): `{provider, model, thinking?}`
  for chats/titles, `{harness:"pi", provider, model, thinking?}`,
  `{harness:"claude", model?, effort?}` — claude is subscription-only
  (ToS by construction). `thinking` is the pi vocabulary, mapped per
  family in `chatLanguageModel(route)` and capability-gated by
  `ModelInfo.reasoning` — rejected at validation on models without a
  knob, never silently sent. Resolution per surface (`resolveRoute`):
  chat/pi = conversation > project > global; claude and cursor = global
  only; titles = titles default, else project default when the project
  forbids it, else skipped. Project restrictions
  (`allowed_providers`/`allowed_harnesses`, null = all) apply AFTER
  resolution — rejected, never swapped. `lib/providers/resolve.ts`
  (`checkRoute`/`requireRoute`) is the one resolver; steps throw
  FatalError on a route that cannot run. Storage:
  `conversations.route`, `projects.default_route`, the `settings` table
  (built-ins = GLM `glm-5.3-flash`, claude subscription default). What
  ran is recorded on the turn's first assistant row's `metadata.route`.
  Write paths live in `lib/providers/settings.ts`; surfaces are the
  chat's route picker (per conversation, not sticky), `/settings`, and
  the project page Models card.
- Skills (0039): markdown runbooks in `skills/<id>/SKILL.md` (front
  matter `description`, plus `thread: true` for one bindable to a
  conversation; loader `lib/skills.ts`). A thread runs one via
  `conversations.skill` — chosen by the creating send (the picker,
  `?skill=<id>`; unknown ids rejected before creating anything) or
  mid-thread by `use_skill`. Its body joins the turn instructions and
  the step budget rises 50 → 400; a thread-skill turn that EXHAUSTS
  continues in a new turn (runEvent `budget`, bounded at 3 consecutive
  continuations with no human message between, `lib/chat/budget.ts`).
  Catalog: `ship`, `ticket` (a PLAN.md reviewed and approved first,
  then ship steps, then a fresh-eyes `review` child before `create_pr`),
  `review` (fresh context, severity-ranked findings, changes nothing).
  Skills without `thread: true` are reference material — never bindable.
- Plan files (0041): a plan is a scratch `PLAN.md` in the
  conversation's work root (`/work/<conv>/` — never in a PR), written
  with `bash`, never re-injected into context. `present_plan`
  (sandboxed chats; `workflows/chat/plan-tools.ts`, core
  `lib/agent/tools/plan.ts`) snapshots it into its tool result — that
  result IS the version, the diff base and the durable copy — and NEVER
  suspends. Before approval it opens a review: a HOOKLESS
  `pending_inputs` row of kind `plan` (only the latest waits; a newer
  present supersedes). `answerPendingWithText` skips plan rows — typing
  is plan discussion. Approval is explicit only: the card's Approve
  (`/api/x/input` `{toolCallId, approvePlan, note?}`; stale versions
  409) resolves the row and WAKES the conversation, or the agent calls
  `accept_plan` (itself approval-gated) when Chad approves in chat.
  After approval `present_plan` is a progress snapshot (`reapprove:
  true` reopens review). The header PHASE chip (`lib/plan.ts`, pure,
  derived from the transcript, never stored). The review skill treats
  `PLAN.md` as the agreed spec. No plan table, no hard gate on
  `create_pr`.
- Web tools (1.5): every chat has `web_search` and `web_fetch`.
  `web_fetch` is plain HTTP (redirects followed, 2 MiB download cap,
  60 k context clip, HTML stripped, textual content types only);
  `web_search` is Z.AI's coding-plan MCP tool over hand-rolled
  streamable-HTTP JSON-RPC, env-gated on `ZAI_API_KEY`. Results are
  value-shaped and framed as untrusted content. Cores
  `lib/agent/tools/web.ts` / `web-search.ts`.
- Browser & screenshot evidence (0035): `Containerfile.sandbox` bakes
  agent-browser + Chrome-for-Testing at build — nothing downloads at
  runtime; a custom `image_ref` without it degrades to agent-checkable,
  never a tool gate. Every sandboxed chat gets `attach_screenshot`:
  copy a PNG from the sandbox (magic-checked, ≤ 10 MiB) to
  `data/attachments/att_<hex>.png`, served immutably by
  `/api/attachments/[id]`. Core `lib/agent/tools/screenshot.ts`.
- Image attachments (0042): the composer takes images by `+`, paste or
  drop (≤ 4 per message, ≤ 10 MiB, type by magic bytes,
  `lib/attachments.ts`). `POST /api/x/attachments` stores the file plus
  an UNCLAIMED `attachments` row; unclaimed rows older than 24 h are
  swept, and a conversation's rows + files go with
  `deleteConversationForever`. The chat message carries `file` parts
  whose data is a REFERENCE (`attachment:<id>`) — never bytes; recorded
  workflow state holds references only. Bytes are swapped in only
  inside `SerializableChatModel.doStream` (`resolveAttachmentPartsStep`
  → `lib/chat/attachment-parts.ts`, with `supportedUrls` +
  `experimental_download` both required or the SDK fetches the scheme).
  No vision gate: a model that rejects an image is the user's error; a
  missing file becomes `[image unavailable]`. Steers are text-only (the
  route 409s an image steer).
- Hosts & the exec tool (0043): a project can list HOSTS — real machines
  its agent may operate on over SSH (`project_hosts`: name, address,
  user, TOFU `host_key_fp`; managed on the project page; the list IS
  the allow-list). One tool, `exec(host, command, timeout?)` (core
  `lib/agent/tools/host.ts`): approval-gated (0034 A — validate WITHOUT
  connecting first; the card shows the exact command; typing denies
  with the text), runs via `bash -lc` as the host's user (120 s default
  / 900 s max; a timeout cuts the channel — the command may still be
  running), 60 k clips, value-shaped failures. Credentials resolve from
  env by host NAME (`HOST_<NAME>_SSH_KEY_FILE` / `_PASSPHRASE` /
  `_PASSWORD`) — nothing enters sqlite, the browser, or any sandbox;
  ssh2 loads via `createRequire` (native addons stay out of the workflow
  bundle), pooled per host, host keys TOFU-pinned (mismatch = hard
  `host-key-changed`). Audit: `host_commands` (write-before-run;
  `host_id` has NO FK so history survives host removal). Secrets
  convention: reference PATHS never contents; API calls run as curl on
  the host holding the credential file. Auto-approve (Chad's decision:
  one toggle, no time limit): `conversations.host_auto_approve`, read
  FRESH on every call (flipping it affects the very next command) — on,
  and the command is not lockout-sensitive, exec skips the gate;
  lockout-sensitive commands ALWAYS ask. Lockout-sensitive
  (`lib/hosts/lockout.ts`) is a word-boundary match on sshd, networking,
  firewalls, nebula, caddy, reboot/shutdown, `nixos-rebuild
  switch|boot`, `ip link|addr|route` — a guard rail, not a security
  boundary. Capability doc `docs/agent/hosts.md`.
- Auth: LAN-only personal tool with no auth layer. **Hard rule: add a
  real verifier before any internet exposure.**
- Persistence north star: SQLite (single db, or split where it makes
  sense) + S3 object storage. **No postgres and no other backends —
  ever.**
- The app store lives in `data/sweatshop.db` (better-sqlite3 + drizzle,
  migrations in `drizzle/`, apply with `npm run db:migrate`):
  `conversations` + `messages`/`steer_queue` (chat history,
  `db/chat.ts`), `harness_calls` (`db/harness-calls.ts`), the sandbox
  lease registry (`db/sandboxes.ts`), and the organization stores
  below. Eve-era transcripts live on in `messages`.
- Conversation organization (0007): per-group (project, or Chats) folder
  trees (`folders`, `conversations.folder_id`), an "Unfiled" list per
  group split by age, archive (searchable) and trash (30-day lazy
  purge, not searchable), manual rename pinned via `title_source`, and
  generated title+summary (`lib/titles.ts`, fired from the turn after
  persisting, max two calls per conversation). All invariants live in
  `db/organize.ts`; routes under `app/api/{folders,conversations}`; the
  sidebar is `components/sidebar/*`; ⌘K palette shares `/api/search`.
- Sidebar parent/child tree (0040/0046): a `start_thread` child nests
  under its parent. Nesting is a property of whatever FLAT list is
  already VISIBLE — never global: `buildSidebarTree`
  (`lib/sidebar-tree.ts`, pure) nests a child under its parent only when
  both are in that same list (cycle-guarded); a parent filed elsewhere
  or deleted leaves the child an ordinary top-level row — a child never
  appears twice. Unfiled buckets by age AFTER nesting, on each ROOT's
  `updatedAt`. Rows are recursive (`conversation-row.tsx`); collapsed
  parents roll up their subtree's attention dots and running spinner;
  viewing a descendant force-opens ancestors. Thread GROUPS are locked
  (0046): organize mutations normalize the dragged id to its topmost
  ancestor and apply to the whole group (cycle-safe walks in
  `db/organize.ts`); children copy the parent's `folderId` at creation
  — a family files, shelves, and dies together. `loadSidebar` injects
  one synthetic `kind: "harness"` row per harness call (read-model
  only; never a conversations row), which opens its own call at
  `/h/<harness>/<conv>/<callId>` and is locked (no menu, not
  draggable). Search results and the Archive/Trash shelves stay flat (a
  search hit on a child carries `· ↳ <parent>` on its breadcrumb).
- Projects & sandboxes (0004, 0031): `projects` (1+ git repos) carry
  their sandbox image directly (`projects.image_ref`; unset =
  `localhost/sweatshop-sandbox` from `Containerfile.sandbox`); git
  credentials resolve by host through the pluggable `GitHost` seam
  (`lib/git-hosts/` — github + forgejo). Conversations bind to a
  project at creation. Sandbox bindings (0013): a conversation's
  sandbox is chosen once, by the creating send — its own (created
  lazily on first sandboxed call, repos cloned into
  `/work/<conversationId>`), none, or attached (same sandbox AND
  workDir). The binding lives in `conversations.sandbox_*`
  (`db/sandboxes.ts`); tools open it via
  `openConversationSandbox`/`openSandbox` (`lib/sandboxes/binding.ts`),
  which never stop or destroy. A bound conversation never switches
  sandboxes — start a new chat. The BINDING is the record of where a
  conversation's calls ran. Post-mortems from outside (0013 phase 6):
  every chat has `inspect` (read-only status/transcript tail/harness
  activity/binding) and `sandbox_exec` (one command in a named sandbox
  without binding the caller; resumes a stopped one, never stops or
  destroys) — `lib/agent/tools/inspect.ts`. Entities are managed on
  the project page (0018); `create_pr` is the agent's PR tool —
  approval-gated EVERYWHERE (0034 A), with RUNTIME-BUILT evidence
  (`lib/agent/tools/evidence.ts`: the project's test command run by the
  runtime in the bound sandbox + the thread's screenshots), stored as
  `pending_inputs.card`. Typing in a thread while it waits on Chad
  ANSWERS the oldest pending input (Chad's decision,
  `lib/chat/answer-pending.ts`): an approval resolves DENIED with the
  text as comment (create_pr returns `changes-requested`), a question
  takes the text as its answer. Approve stays an explicit button.
  Harnesses hold no git write powers at all.
- Machines (0009) — **deleted 2026-10-10 (0037 phase 5) and purged
  (0048)**: no machine tables, tools, views, or run branches remain.
  The work surfaces now: a chat running a SKILL, the gated tools
  (`create_pr`, `exec`), and `start_thread` children — see those
  bullets. History and rationale: docs/0037, docs/0048.
- Agent everywhere (0015): every chat has the project tools, gh/forgejo,
  inspect / sandbox_exec, cancel_run, start_thread, web tools and
  ask_chad, all value-shaped so the model repairs its calls. Page
  context: pages register what they are (`components/page-context.tsx`)
  and a panel send carries a "[viewing]" note — a user-role message
  stored as `messages.metadata` (never text), rebuilt each turn,
  rendered as a chip. The agent panel (`components/agent-panel.tsx`) is
  an ordinary ChatSession in a right-side frame (⌘J; pushed on lg+,
  overlaid below), binds to the page's project at the creating send and
  never switches. The session instance is never remounted on adoption —
  the transport's mid-turn reconnect only works while its useChat
  instance lives.
- Harness agents (0005/0006, 0010 phase 3, 0022, 0038): project
  conversations have `pi`, `claude` and `cursor` tools — separate
  coding harnesses on the conversation's sandbox, up to
  `MAX_CONCURRENT_HARNESSES` (3) at once, at most one call per kind
  (they share the sandbox's checkout — the instructions say to give
  concurrent harnesses separate files/areas, or `start_thread({fresh:
  true})`). CHAT calls are BACKGROUND work (0022): the tool step
  validates the route, atomically claims a slot (`claimHarnessRun`,
  one sqlite transaction — denial names WHY: `same-kind` or `cap`),
  inserts a `harness_calls` row (`hc_…`), and starts one
  `harnessCall` workflow — the tool returns the handle immediately.
  The worker advances the harness ONE semantic step per `"use step"`
  and settles: persist `resumeFrom` (natural completion only —
  cross-call continuity is durable in `chat_harness_state`), settle the
  row, release the slot, WAKE the conversation with the clipped final
  text (each call's wake is independent). A kind's slot is held for the
  call's whole life; any running row keeps the sandbox in the reaper's
  busy set. `cancel_run` cancels that one workflow (settles cancelled,
  no wake); settles are running-only writes so the first final write
  wins. Transports: pi (`@ai-sdk/harness-pi`) runs in-process on GLM
  via the Z.AI Anthropic Messages surface; claude
  (`@ai-sdk/harness-claude-code`) runs the official Agent SDK as an
  in-sandbox bridge process over the private `sweatshop-harness` podman
  network (membership is the boundary, never a published LAN port),
  each kind on its OWN port (`HARNESS_BRIDGE_PORTS` — claude 4000,
  cursor 4001); a settled call's bridge is kept running on purpose
  (`resumeFrom`) so the same kind's next call reattaches. claude auth:
  a setup-token as `CLAUDE_CODE_OAUTH_TOKEN` (`auth: "direct"`),
  env-gated until set. cursor (0038) authenticates from the CLI's
  BROWSER-LOGIN `auth.json` (`data/harness-auth/cursor/auth.json`;
  `lib/harness-auth/cursor.ts` is the one seam), re-planted into the
  CLI's private HOME in the sandbox every step (env-var base64, never
  argv or logs); the access token as env var is REJECTED — only the
  file authenticates; a login inside 1 h of expiry is refused.
  Persistence: `harness_events` + `harness_runs` keyed (conversation,
  harness); `/h/<harness>/<conversationId>` is the one URL shape
  (legacy shapes permanent-redirect). Packaging pins:
  `pi-coding-agent` 0.85.1 exactly; harness 1.0.141 / harness-pi
  1.0.143 / harness-claude-code 1.0.145 (the ai / workflow /
  provider-utils line moves with the harness pin — one deliberate
  bump). Adapter rules: env goes as `docker exec -e` flags, exec uses
  `bash` not `sh`, bridge processes need real streaming spawn.
- Repo AGENTS.md for agents (2026-10-16, approved in chat): no harness
  or top-level agent reads a project repo's AGENTS.md unprompted, so
  the app injects them. At turn start, when the conversation has a
  project AND its sandbox is already BOUND (never provisioned just to
  read), `loadRepoDocsStep` reads each repo's AGENTS.md (24 KB per
  file, 48 KB total — a file that does not fit is dropped with a `cat`
  pointer) and `buildInstructions` appends them. Harnesses start at
  the work root: `setupProjectWorkspace` writes
  `<root>/AGENTS.md` + `<root>/CLAUDE.md` (identical, rebuilt every
  setup). `buildInstructions` also routes work: bash to look, a
  harness for any real code change, exec for live host state only.
- Previews (0016/0017): a preview is a long-running HTTP server in a
  sandbox, owned by the SANDBOX (outlives the turn that started it).
  Registry `previews`, lifecycle `lib/previews/service.ts` (the one
  start/stop/reconcile path); processes run DETACHED (`setsid nohup`,
  pid/log under `/work/.previews/`) so app restarts never kill them.
  Reached at `https://pv-<slug>.internal.crussell.io` (bee Caddy →
  10.10.0.12:3301 → the hand-rolled Host-routing proxy
  `lib/previews/proxy.ts` — not a Next route → the sandbox container).
  Node-only background work (reaper, proxy, tick) starts from
  `instrumentation-node.ts` (kept out of the edge bundle). Preview
  tools (`start_preview`/`preview_status`/`stop_preview` +
  `get/save_preview_setup`) come with any sandbox; start is idempotent
  per (sandbox, dir, port) and injects PORT/HOST/PREVIEW_HOST/
  PREVIEW_URL — platform vars are FINAL over the layered env (project
  setup → per-preview `previews.env` → platform; `${PREVIEW_URL}`
  etc. interpolate at launch); defaults come from the saved setup,
  else `describeDir` prefills once. Declared SERVICES (0017 phase 3,
  `sandbox_services` + `lib/sandboxes/services.ts`): containers that
  JOIN the sandbox's network namespace (dev apps' self-URLs just
  work), owned by the sandbox, ensured at provisioning and every
  launch, readiness probed FROM INSIDE the sandbox,
  `${service:<name>:<port>}` resolves to `localhost:<port>`; the
  setup's `migrate` runs once per sandbox after services are healthy
  (`sandboxes.migrated_at`), then `seed` once
  (`sandboxes.seeded_at`, idempotent by convention); services stop and
  resume with the sandbox and die with it. Branch previews
  (`lib/previews/branch.ts` + `follow.ts`): New preview is TWO-PHASE
  (provision → discover → confirm; a saved setup skips discovery),
  then a deterministic FOLLOWER in the tick (fetch → ff, hard reset on
  force-push, reinstall only on dependency changes, else trust HMR);
  a failure parks the preview `failed` at that sha (it keeps serving
  the last good commit) and raises a needs-you Inbox card (Fix it = a
  chat attached to the preview's sandbox). Abandoned `provisioning`
  rows age to `failed` after 30 min. Reaper: a provisioning/starting/
  healthy preview makes its sandbox busy; previews idle past
  `GC_PREVIEW_STOP_HOURS` (12) are stopped. LAN/Nebula only — no auth,
  never route publicly.
- Inbox & attention (0008, approved in chat): `/inbox` is a dashboard
  of what is waiting on Chad. **Needs you** = pending human-input
  requests; stays until answered — opening the thread does not clear
  it. **Unread** = assistant output newer than
  `conversations.last_seen_at`; opening a conversation marks it seen
  (only while the tab is visible AND focused); per-item mark read
  via `PUT /api/conversations/[id]/seen`. Pending requests are
  `pending_inputs` rows — the single source since 0032 — resolved by
  `/api/x/input`; cards (`components/inbox/`) answer approvals by
  POSTing there. The sidebar shows the same signal as dots (amber =
  needs you, filled = unread), rolled up on collapsed folders/groups,
  kept live by `lib/use-attention-sync.ts` (polls `GET /api/attention`
  every 5 s while the tab is visible; refreshes only when the
  signature changes). Dots only — no tab-title flash, no
  notifications.

## Environment

Nothing is installed on the host; everything runs in podman. There is
ONE instance (0020) — no dev server, no second checkout:

- **The app** is the `sweatshop` rootless user quadlet on bee (cn
  `hosts/bee/sweatshop.nix`): `next start` of a production build of
  THIS checkout, on http://localhost:3300 plus the preview proxy on
  10.10.0.12:3301. Restart=always. Logs: `journalctl --user -u
  sweatshop` (agent shells need `XDG_RUNTIME_DIR=/run/user/1000`).
- **This checkout is the deploy checkout.** It tracks `main` on Forgejo
  and moves ONLY through the deploy workflow (0045): merge → checks →
  `scripts/ci-deploy.sh` inside the `sweatshop-deploy` transient user
  unit (fast-forward → `data/backups/pre-<sha>.db` snapshot → stop →
  `npm ci` + `next build` + `db:migrate` → start → health check; a
  failed build restores the previous commit; an already-live healthy
  sha is a no-op). Rollback = Actions UI → deploy → run with the sha.
  `ci-deploy.sh` refuses to run outside the transient unit — deploys
  are never launched by hand or by the app's agents.
- **Changing sweatshop** = an ordinary project: a sandboxed chat on the
  `sweatshop` project opens a PR; the merge ships it. dsh is the
  emergency path when a deploy breaks the app (extract the script from
  the target commit, create the transient unit by hand — the exact
  command lives in the git history of this paragraph, docs/0045).
- **State** is all under `data/` (nightly restic + a `VACUUM INTO`
  snapshot at `data/backups/nightly.db`): `sweatshop.db` (+WAL),
  `workflow-data/` (the Workflow SDK local world —
  `WORKFLOW_LOCAL_DATA_DIR` together with `WORKFLOW_TARGET_WORLD=local`;
  without the latter a build may wipe the dir), `backups/`. `node
  scripts/db-snapshot.mjs <name>` takes a consistent online copy.
- `./dev exec -- <cmd>` — one-off command in a container with the
  app's mounts (the gate, migrations against a temp db, scripts).
  `./dev install`, `./dev shell`, `./dev build`. node_modules live in
  the `sweatshop-node-modules` volume, SHARED with the running service
  — never `./dev install` on bee; dependency changes land by PR and
  `ci-deploy.sh` runs `npm ci` while the service is stopped. The host
  rootless podman socket is mounted at `/var/run/docker.sock`
  (sandboxes are sibling containers); every invocation joins the
  private `sweatshop-harness` network (0006).
- Agent shells must run podman under escalated (full-access) file
  permissions — podman writes runtime state under `/run`.
- Workflow SDK docs are vendored at `docs/workflows/` — read and grep
  them on the host (also `node_modules/ai/docs` for the AI SDK).

## Old repo policy

The prototype lives at `~/sweatshop`. It is a valid reference for
implementation details but **not** for design — it accreted spaghetti
and cruft, which is why this repo exists. Extract the specific fact you
need; write it fresh here. Never copy structure or code wholesale.

## Skills

Vendored under `.agents/skills/` (tracked by `skills-lock.json`):

- `ai-sdk` — load before writing any AI SDK / provider code.
- `ai-elements` — load before any chat UI work.
