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

- **Branch / remote:** `origin` is `chad-russell/sweatshop` on GitHub —
  the source of truth: PRs open there, and the GitHub Actions gate
  (`.github/workflows/ci.yml`: typecheck, lint, test) must pass before
  merge. `main` is this repo; the prototype's history lives on as
  `archive/prototype` + its `v0.*` tags. `git.crussell.io` Forgejo is
  now only a pull mirror of GitHub, whose deploy workflow (0045) ships
  merged `main` (from the mirror) to the host. Agents work on branches
  and open PRs on GitHub; Chad merges.
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
  duplicate). A reload, wake, or steered send onto a LIVE turn hydrates
  every slice persisted so far, then resumes the AI SDK's own durable
  stream (`chat.resumeStream()` via `WorkflowChatTransport`'s
  `prepareReconnectToStreamRequest`) from `conversations.
  active_stream_cursor` — the raw journal index `persistTurn` records
  after each non-final slice (`getRun(id).getReadable().getTailIndex()
  + 1`); `GET /api/x/chat/<runId>/from/<cursor>/stream` is that
  reconnect route, `[runId]/stream` (cursor 0) stays only for a tab
  reconnecting to its own dropped send. The cursor is cleared alongside
  `active_run_id` everywhere that is. No homemade slice poll and no
  from-chunk-0 journal replay on reload (0077, superseding 0076's
  #19-#21); the 5 s wake poll only discovers a server-started turn
  while idle, handing off to resume. ONE durable
  stream per turn (`preventClose` + `sendFinish: false`;
  `finishTurnStream` emits the single `finish` and closes AFTER
  `persistTurn`). A fresh page stays on `/` while its creating turn is
  live, moving to `/c/<id>` only once it settles (`onAddressable`).
  Loop guard (0082): after every slice, `applyLoopGuard` signs each new
  tool call (stable hash of toolName + input + result, `lib/chat/
  loop-guard.ts`) and counts repeats across the WHOLE turn (plain
  function-local state — purely derived from `messages`, so a replay
  recomputes it identically); the 3rd time one signature repeats, a
  runEvent `"loop"` user row (drained into the next slice exactly like a
  steer message, persisted via `persistTurn`'s `runEvents` map) tells the
  model to change approach or stop, firing once per signature per turn
  (RCA: a child thread looped an identical failing `npm run` ~200 times
  and burned its whole budget unnoticed).
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
  words. The text includes the parent's current active step when the
  thread has an outline, and a child thread's wake also includes that
  child's active outline step. Idempotency is `woken_settled_at` (stamped after delivery —
  duplicates over losses); the 30 s sweep in `instrumentation-node.ts`
  re-fires what the in-run wake missed (`WAKE_SWEEP=off` disables).
  0084: that same tick also polls the chat's open `pr_watches`
  (registered by `create_pr`'s success path; deterministic ids) and
  wakes the opening conversation when the host merges or closes a
  watched PR (`lib/prs/sweep.ts`, runEvent kind `"pr"`;
  `PR_WATCH=off` disables just that pass).
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
  `lib/chat/harness-call-start.ts`, the one place task becomes the
  workflow prompt for pi/claude/cursor/codex alike). A turn that exhausts its budget
  mid-tool-call marks `metadata.exhausted` on its LAST assistant row;
  the wake then reports "ran out of steps" instead of "finished".
  Transcript cards show the child's live status: `GET /api/x/status/<id>`
  (`lib/child-status.ts`, both live kinds) polled by `useChildStatus`
  every 5 s while the child is live and the tab visible, never once
  settled.
- Harness lanes (0083): the four harness tools (`pi`/`claude`/`cursor`/
  `codex`) take an optional `dir` — a lane: a FRESH session rooted at that
  sandbox-relative subdirectory (never reads/writes `chat_harness_state`),
  one lane per distinct dir per kind alongside the unchanged default lane.
  `harness_runs` is keyed (session, kind, dir; default dir `''`, not NULL —
  sqlite unique-index NULLs would break the claim upserts) and lanes of
  bridge kinds lease a port from the per-sandbox `LANE_BRIDGE_PORTS` pool
  (released at settle); `MAX_CONCURRENT_HARNESSES = 3` still bounds the
  conversation total. Combine with git worktrees for parallel independent
  tasks — the controller pattern's wave dispatch.
- Sandboxed commands (0082): `execSandbox` (`lib/sandboxes/provision.ts`,
  the one non-streaming path for bash, `sandbox_exec` and the AI SDK
  adapter's `run`) prepends `set -o pipefail` (`withPipefail`), so a
  pipeline like `npm run test 2>&1 | tail` reports npm's failure instead
  of `tail`'s 0. Streaming harness spawns are unaffected.
- Child threads (0037 phase 3): `start_thread({prompt, skill?, fresh?})`
  — every chat tool — starts a fresh child chat with its own context on
  the parent's project, ATTACHED to the parent's sandbox by default
  (`fresh: true` provisions its own), running the prompt as its first
  turn. The child records `conversations.parent_conversation_id` and
  wakes the parent when it settles (`woken_settled_at` stamped at
  creation; settle = `updated_at` past it with no live turn;
  `wakeParentStep` runs after the budget decision), carrying the child's
  last REAL assistant report; a child with none is stamped woken
  silently. Children get the thread step budget (800, `resolveMaxSteps`)
  even un-skilled (`hasParent`); the budget CONTINUATION is skill-only —
  an un-skilled child that runs out reports once, never re-fires itself.
  0082: an attached child whose parent's binding sits at the bare work
  root (never `cd`'d into a repo) lands inside the repo instead when the
  project has exactly one (`childSandboxWorkDir`,
  `lib/sandboxes/binding.ts`) — a multi-repo project, a parent already
  inside a repo subdir, or no project, keep the parent's exact workDir.
- UI is Vercel AI Elements on shadcn + tailwind. The visual system is
  the `DESIGN.md` token contract: semantic tokens only, never raw
  hex/oklch in TSX; themes `clickhouse` (default), `cal`, `nova`.
  Components never import `@/db` (Biome-enforced); read-model types live
  in `@/lib/read-models` (0049). A composer-bar usage control (0051 +
  0047, merged 0055 PR2) shows a ring, the conversation's last metered
  slice as a percentage of the model's catalog window, and cost;
  hidden until metered, ring-only below `sm`; clicking opens the same
  stats breakdown (context first) as a popover. Below `sm` (0080) the
  composer footer's model picker, sandbox picker, and host auto-approve
  toggle collapse into one settings chip (`components/composer-settings.tsx`)
  that opens a bottom sheet with the same three controls full-width — the
  usage control stays ring-only as above. The header itself just
  holds crumbs · the work pill · the preview pill — the outline's own
  phase/progress chrome lives in the composer-docked outline tray (0079)
  instead, not the header. `lib/thread-phase.ts`'s `phaseFromMessages`
  (outline-only, 0064 — a PR is never the phase) still backs the agent
  panel's compact chip (`components/status-chip.tsx`). The work pill
  (0078, `components/work-pill.tsx`) is the PR control: `lib/work-prs.ts`'s
  `workPRsFromMessages` tracks every `create_pr` call in the transcript
  (pending/open, denied/errored dropped, retried opens deduped by url),
  0 PRs renders nothing. While any PR is open the client polls
  `GET /api/x/prs` per PR url and `applyLiveStates` relabels each one
  merged/closed at render time. One PR shows a state dot + `#n` + word;
  several show a count, the dot coloured by whichever needs the most
  attention. `mergeBreakdowns` aggregates each PR's diff breakdown (when
  it has one) into the same fixed categories as a single PR's
  (Generated/Tests/Docs/Migrations/Config/Code, `lib/diff-breakdown.ts`);
  the pill's popover lists every PR plus that aggregate table.
- Quiet tool groups (0056) keep their full-width collapsible box and
  render calls with shadcn Trace (`components/ui/trace.tsx`): action
  first, expandable specialized cards, repeated polls still folded.
  Individual failures stay red; group status describes activity
  (running/completed) with a failed-call count, not task success.
- Harness session view (0063): `/h/<harness>/<session>[/<call>]` folds
  events with `buildTimeline`, converts them with `timelineToParts`
  (1:1 with the items; non-tool items become text parts so they end a
  run) and renders `groupParts` + `ToolGroupView` — the SAME grouping
  path and `QUIET_TOOLS` allow-list as chat, for every harness. Tool
  names are lowercased by `canonicalTool` (stored rows untouched);
  codex's `/bin/bash -lc "<cmd>"` wrapper is stripped for display by
  `unwrapShell`. Cancel: `POST /api/x/harness-calls/<hc_…>/cancel` →
  `cancelRunTool` (cooperative — settles `cancelled` now, the workflow
  tears the bridge down at its next step boundary; never
  `workflow.cancel()`). The page hydrates the NEWEST `HARNESS_PAGE`
  (500, `lib/harness-paging.ts`) events (`tail`, still oldest-first,
  call window kept), polls `after=<lastId>` while running, and pages
  older with Load earlier (`before=<id>` → newest page below it +
  `hasOlder`; the timeline is rebuilt over the merged list, so a page
  cut mid tool call shows an input-less finished call until its start
  loads). It renders in the chat's stick-to-bottom `Conversation`
  (`initial="instant"`), prepends pinned by the shared 0075 anchor
  (`lib/use-prepend-anchor.ts` + `components/prepend-sentinel.tsx`),
  ends with a `Working…` status row while running, and shows
  `CancelCallBar` (composer-width stop bar) under the log; the chat's
  `HarnessCard` keeps the compact `CancelCallButton`. Both share
  `useCancelCall` (confirm, POST, re-arm on failure).
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
  `{harness:"claude", model?, effort?}`, `{harness:"cursor", model?}`,
  `{harness:"codex", model, effort?}` — claude, cursor and codex are
  subscription-only (ToS by construction; cursor routes validate against
  the CLI login and codex routes against the saved ChatGPT login:
  missing/invalid/expired refuse value-shaped, and a codex route must
  PIN its model — the adapter's default is rejected on subscriptions,
  0050). `thinking` is the pi vocabulary, mapped per
  family in `chatLanguageModel(route)` and capability-gated by
  `ModelInfo.reasoning` — rejected at validation on models without a
  knob, never silently sent. Resolution per surface (`resolveRoute`):
  chat/pi = conversation > project > global; claude, cursor and codex =
  global
  only; titles = titles default, else project default when the project
  forbids it, else skipped. Project restrictions
  (`allowed_providers`/`allowed_harnesses`, null = all) apply AFTER
  resolution — rejected, never swapped. `lib/providers/resolve.ts`
  (`checkRoute`/`requireRoute`) is the one resolver; steps throw
  FatalError on a route that cannot run. Storage:
  `conversations.route`, `projects.default_route`, the `settings` table
  (built-ins = GLM `glm-5.3-flash`, claude subscription default, codex
  `gpt-5.6-sol` — always pinned, 0050). What
  ran is recorded on the turn's first assistant row's `metadata.route`.
  Write paths live in `lib/providers/settings.ts`; surfaces are the
  chat's route picker (per conversation, not sticky), `/settings`, and
  the project page Models card.
- Gloo prompt caching (0057): Anthropic chat/title and pi requests send
  `X-Cache-TTL: 5m`; other families cache implicitly. Chat provider usage
  normalizes standard cache fields plus Anthropic aliases before workflow
  capture. `usage_events.cache_write_tokens` is separate from cache reads
  (`cached_tokens`); both are subsets of total input. Costs include writes
  at the five-minute rate, reads at the read rate, and newly fetched Gloo
  prices include the guarded alias's 1.065 fee. Historical costs stay put.
- Skills (0039, 0054, 0064): markdown runbooks in `skills/<id>/SKILL.md`
  are shipped defaults (front matter `description`, `thread: true` for a
  bindable runbook, `status: disabled` to ship pre-retired — ship uses
  this). SQLite `skills` / `skill_versions` hold the active catalog;
  `lib/skills.ts` reads it (lazy seed once from Git, no silent overwrite
  on deploy; an unedited default is upgraded by a guarded path).
  `/settings` edits or resets individual skills; agent
  `propose_prompt_change` changes require approval. Status is
  versioned: active, disabled, deleted (tombstone); existing bound
  threads still read the current body even if disabled/deleted, but
  only active thread skills can be newly bound. A thread runs one via
  `conversations.skill` — chosen by the creating send (`?skill=<id>`;
  unknown ids rejected before creating anything) or by
  `start_thread` for a child. `use_skill` with no id lists the catalog;
  `use_skill({id})` loads that active skill's body as the tool result,
  any number of times, and never binds. A bound skill's body joins the
  turn instructions and the step budget rises 100 → 800; a thread-skill
  turn that EXHAUSTS continues in a new turn (runEvent `budget`,
  bounded at 6 consecutive continuations with no human message between,
  `lib/chat/budget.ts`). Catalog: `ticket` (planned work to a PR, run
  through an outline — see Outline below), `review` (fresh context,
  severity-ranked findings, changes nothing). `ship` is retired (a
  seeded `disabled` version, restorable). Skills without `thread: true`
  are reference material — never bindable.
- Outline (0064 — supersedes 0041's PLAN.md, 0055 modes and 0059
  status): the ONE plan/progress/phase mechanism. `update_outline`
  (every chat) rewrites the whole step tree in one call —
  `{goal, steps: [{id, label, state, detail?, children?, runner?}],
  note?, propose?}` — any depth (cap 4, 200 nodes; goal 300 / label 200
  / detail 500 / note 500 chars), unique ids kept across rewrites, at
  most one ACTIVE top-level step, and a `runner`
  (`"auto"|"self"|"thread"` or a pinned `HarnessRoute`) on top-level
  steps only. Only top-level steps are units of delegation; children
  are the to-do list for whoever does that step. `lib/outline.ts` is the
  pure core (no db import): `validateOutline`, `deriveOutline`
  (current/history/stale from `update_outline` results and
  `outline-edit` rows; legacy `update_status` results adapt with no
  goal, ids slugged from labels, runner `"auto"`), `outlineChip`,
  `diffOutlineSteps`, `runnerGate`, `renderOutlineHandoff`, and
  `renderThreadStateNote` (goal, active step + runner + open children,
  next step + runner, "if this changed, call update_outline"; rendered
  once and replayed verbatim for cache stability). `lib/status.ts` keeps
  only the legacy `update_status` shape check and the shared transcript
  walkers. Review: `propose: true` opens a hookless `pending_inputs`
  row of kind `outline` (`db/outlines.ts`; a newer proposal supersedes)
  without suspending; `accept_outline` (approval-gated) or the card's
  Approve (`/api/x/input` `{toolCallId, approveOutline, note?}`)
  resolves it and WAKES the conversation (`[outline vN approved]`).
  Owner edits (`/api/x/input` `editOutline` + `baseVersion`, stale → 409,
  full route validation against project allow-lists,
  `lib/chat/outline-edit.ts`) append an `outline-edit` user row (a
  chip, never the owner's words); in review any edit is allowed and
  supersedes the review, otherwise only pending top-level runners
  change (enforced server-side); edit+approve is one wake.
  Enforcement (`runnerGate`, before any harness slot claim or child
  creation): `self` forbids delegation, `thread` permits only
  `start_thread`, a pinned route permits exactly that harness and route
  (overriding resolution, still `checkRoute`-validated), `auto`
  unrestricted; refusals tell the agent to `update_outline`. Workers
  (harness calls, `start_thread` children) get the goal + active step's
  subtree prepended (`[outline context]`, a collapsible in a child's
  first message); `harness_calls.step` / `conversations.work_step`
  record the step label for cards, the sidebar, `childStatus` and
  `inspect`. UI: `components/outline-card.tsx` (goal, recursive tree,
  runner badges shown only for a pinned/non-`auto` runner, "changes
  since vN" including removed steps, review editing — the document +
  edit + approve flow is `OutlineBody`, shared with the tray below) and
  the Inbox outline card. The always-visible surface is the
  composer-docked outline tray (0079, `components/outline-tray.tsx`) —
  a one-line borderless tinted bar just above the composer (detached, small gap), fed by the whole
  transcript the same way `phase`/`prs` are (`ChatContextBlock.outline`,
  `lib/outline.ts`'s `deriveOutlineTrayContext`): segmented progress per
  top-level step, `d/n`, the active/blocked step's label
  (`outlineTraySummary`), `needs you` when blocked or in review, a
  stale hint after an un-followed wake. Tapping it expands upward into
  the full `OutlineBody` (edit/approve included) without leaving the
  composer; transcript cards default closed except the latest open
  review, since the tray — not wherever a card happens to sit — is now
  the one place status is always visible. The old header chip is gone;
  the header's own PR control is the work pill (0078), unrelated to the
  outline. `components/work-chip.tsx` in the composer ("N working",
  live background work with step labels; hidden when idle) is separate
  from the tray and unchanged. Skills are plain runbooks — no `mode`
  flag, no phases, no mode entry on send; `use_skill` loads text. Legacy read-compat:
  historical `present_plan` results render read-only
  (`components/legacy-plan-card.tsx`, `lib/legacy-plan.ts`) and open
  `plan` review rows are hidden from the Inbox and typed answers, never
  resolved by typing.
- Structured questions (0081): `ask_owner`'s `kind: "question"` path takes
  optional `context` (markdown reasoning, kept out of the short `question`
  one-liner) and `questions` (1–4 structured sub-questions: `single`/
  `multi`/`rank`/`text`, 2–8 options for choice types, at most one
  `recommended` on a `single`). `kind: "approval"` only gains `context`
  (no `questions`). Every choice question always offers "Other…" and
  "You pick" (runtime-supplied — `allowOther` gates only "Other…"); per-
  option `evidence` (`code`/`diff`/`markdown`/`link`/`screenshot`) is
  resolved at ask time (`workflows/chat/steps/ask-owner.ts`'s
  `resolveAskOwnerCardStep` — a `screenshot` path is attached through the
  existing `attach_screenshot` core to an attachment id, never bytes in
  workflow state) and stored as an `AskOwnerCard` in `pending_inputs.card`
  (`lib/question-form.ts` — pure core: validation, formatting, the
  composer's typed-text mapping, server-side answer validation; no db
  import). The hook (`chatApprovalHook`) gained `answers?: Record<qid,
  {selected?, other?, youPick?}>` beside the legacy `answer?: string`
  (Dismiss and a plain freeform question still use `answer`);
  `POST /api/x/input` validates `answers` against the stored card before
  ever touching the hook. One shared `components/question-form.tsx`
  (`QuestionForm`) renders a structured ask in both the transcript's
  `AskOwnerCard` and the Inbox's `QuestionCard` — rank reorders with
  up/down buttons (no drag-and-drop dependency), keyboard `1`-`9`
  selects/toggles an option in the focused question, `Enter` submits.
- Prompt sections (0054): three app-supplied instruction blocks in
  `workflows/chat/instructions.ts` ship as Git defaults; SQLite
  `prompt_sections` / `prompt_section_versions` own active text (lazy
  seeded, reset copies the current Git default as a new version). The
  base, sandbox and host guidance are all editable in `/settings`, with
  history, compare, preview and optimistic concurrency. The same store
  validates agent proposals (`propose_prompt_change`), which always
  ask Chad before writing. Tool availability, approval and lockout gates
  remain code-enforced, never controlled by prompt prose.
- PR dashboard (0053): a top-level `/prs` page lists every PR by the
  repo's own credential account across ALL project repos (hand-opened
  and agent-opened alike) — asked LIVE through `GitHost.listPRs` on
  page view, stored nothing (the 0052 philosophy; refresh re-asks).
  The seam returns `PRSummary[] | null` (never throws): open PRs by
  the account carry an aggregated review verdict (`aggregateReviews`
  — latest review per reviewer, changes-requested > approved >
  commented), comment counts ride the list rows on Forgejo (GitHub
  list rows lack the field, so counts show only when known), review
  fetches are
  bounded to 25 open PRs per repo. Loader `lib/prs/dashboard.ts`
  resolves each repo's credential, filters by author
  case-insensitively, dedupes by canonical URL, sorts open first
  (changes-requested → commented → activity); a repo that can't be
  asked is a red note, never fatal. Sidebar nav row beside Inbox, no
  badge (that would need background polling). No PR table, no
  webhooks, no CI status (deferred).
- Web tools (1.5): every chat has `web_search` and `web_fetch`.
  `web_fetch` is plain HTTP (redirects followed, 2 MiB download cap,
  60 k context clip, HTML stripped, textual content types only);
  `web_search` tries backends in order — Z.AI's coding-plan MCP tool
  (`ZAI_API_KEY`), codex (the stored ChatGPT login, hosted web_search over
  the codex Responses endpoint), claude (`ANTHROPIC_SEARCH_API_KEY`,
  Messages API server tool), tavily (`TAVILY_API_KEY`) — skipping any that
  is unconfigured and falling through on failure; `WEB_SEARCH_PROVIDERS`
  reorders. Cursor has no standalone search, so no slot. Results are
  value-shaped, carry `provider`, and are framed as untrusted content.
  Orchestrator `lib/agent/tools/web-search.ts`, backends in
  `lib/agent/tools/search-providers/`, fetch core `lib/agent/tools/web.ts`.
- Browser & screenshot evidence (0035): `Containerfile.sandbox` bakes
  agent-browser + Chrome-for-Testing at build — nothing downloads at
  runtime; a custom `image_ref` without it degrades to agent-checkable,
  never a tool gate. Every sandboxed chat gets `attach_screenshot`:
  copy a PNG from the sandbox (magic-checked, ≤ 10 MiB) to
  `data/attachments/att_<hex>.png` (`ATTACHMENTS_DIR` relocates the
  root), served immutably by `/api/attachments/[id]`. Core
  `lib/agent/tools/screenshot.ts`.
- Image attachments (0042): the composer takes images by `+`, paste or
  drop (≤ 4 per message, ≤ 10 MiB, type by magic bytes,
  `lib/attachments.ts`). `POST /api/x/attachments` stores the file plus
  an UNCLAIMED `attachments` row; unclaimed rows older than 24 h are
  swept, and a conversation's rows + files go with
  `deleteConversationForever`. The chat message carries `file` parts
  whose data is a REFERENCE (`attachment:<id>`) — never bytes; recorded
  workflow state holds references only. Bytes are swapped in only
  inside `SerializableChatModel.doStream` (`resolveAttachmentPartsStep`
  → `lib/chat/attachment-parts.ts`; `supportedUrls` keeps `attachment:`
  references intact inside the model step, while WorkflowAgent itself
  preserves URLs during workflow-side conversion, 0085).
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
  ask_owner, all value-shaped so the model repairs its calls. Page
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
  conversations have `pi`, `claude`, `cursor` and `codex` tools — separate
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
  cursor 4001, codex 4002 (0050)); a settled call's bridge is kept
  running on purpose
  (`resumeFrom`) so the same kind's next call reattaches. claude auth:
  a setup-token as `CLAUDE_CODE_OAUTH_TOKEN` (`auth: "direct"`),
  env-gated until set. cursor (0038) authenticates from the CLI's
  BROWSER-LOGIN `auth.json` (`data/harness-auth/cursor/auth.json`,
  `HARNESS_AUTH_DIR` relocates; `lib/harness-auth/cursor.ts` is the one
  seam), re-planted into the
  CLI's private HOME in the sandbox every step (env-var base64, never
  argv or logs); the access token as env var is REJECTED — only the
  file authenticates; a login inside 1 h of expiry is refused. codex
  (0050) authenticates from the ChatGPT-login `auth.json`
  (`data/harness-auth/codex/auth.json`, same root; `lib/harness-auth/
  codex.ts` the seam) — auth is ENV-CARRIED, nothing planted: the
  adapter resolves the subscription from `CODEX_HOME` (pointed at the
  auth dir at boot), refreshes tokens in place, and forwards
  `CODEX_API_KEY` to the bridge; the enterprise account id rides the
  agent `headers` (`ChatGPT-Account-ID`). Login is IN-APP
  (`lib/harness-auth/codex-login.ts` + `/api/x/codex/login/*`): the
  browser OAuth flow is primary (PKCE + state, the pasted
  `localhost:1455` callback, form-encoded exchange), device-code
  secondary (blocked by enterprise workspaces — Chad's is), paste
  third. Any API-key env var (`OPENAI_API_KEY`/`CODEX_API_KEY`/
  `AI_GATEWAY_API_KEY`/`VERCEL_OIDC_TOKEN`) SHADOWS the subscription —
  the builder fails fast naming it.
  Persistence: `harness_events` + `harness_runs` keyed (conversation,
  harness); `/h/<harness>/<conversationId>` is the one URL shape
  (legacy shapes permanent-redirect). Packaging (0085): exact pins live
  in `package.json`; the harness, pi, AI SDK, Workflow and provider-utils
  line moves together. Lint uses Biome with formatting and import sorting
  disabled; `biome.jsonc` owns migration exceptions and the component/store
  import boundary. Adapter rules: env goes as `docker exec -e` flags, exec uses
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

This section describes the author's deployment (bee); for running
sweatshop elsewhere — another engine, a laptop, another host — see
README.md.

Nothing is installed on the host; everything runs in podman. There is
ONE instance (0020) — no dev server, no second checkout:

- **The app** is the `sweatshop` rootless user quadlet on bee (cn
  `hosts/bee/sweatshop.nix`): `next start` of a production build of
  THIS checkout, container name `sweatshop-dev` (kept so the
  harness-network name and `sandbox:gc`'s default URL hold), image
  `localhost/sweatshop-dev`, on http://localhost:3300 (host 3000 is
  taken) plus the preview proxy on 10.10.0.12:3301. Restart=always,
  starts at boot. Logs: `journalctl --user -u sweatshop` (agent shells
  need `XDG_RUNTIME_DIR=/run/user/1000`).
- **This checkout is the deploy checkout.** It tracks the Forgejo
  mirror of `main` (GitHub is the source of truth; Forgejo pulls from
  it) and moves ONLY through the deploy workflow (0045): merge → checks →
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
  `./dev install`, `./dev shell`, `./dev build` (rebuilds the image the
  service uses; container root maps to the host user; `.env.local`
  passes via `--env-file`). node_modules live in
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
- Live-check spikes (opt-in, env-gated, skipped in the normal gate; env
  set INSIDE the container): `THINKING_SPIKE` (0021), `PI_SPIKE`
  (0005/0006), `CLAUDE_SPIKE` (+`_LIVE`) (0006), `CURSOR_SPIKE`
  (0038), `HOST_SPIKE` (0043), `PREVIEW_E2E` (0019), `SERVICES_SPIKE`
  (0017).

## Old repo policy

The prototype lives at `~/sweatshop`. It is a valid reference for
implementation details but **not** for design — it accreted spaghetti
and cruft, which is why this repo exists. Extract the specific fact you
need; write it fresh here. Never copy structure or code wholesale.

## Skills

Vendored under `.agents/skills/` (tracked by `skills-lock.json`):

- `ai-sdk` — load before writing any AI SDK / provider code.
- `ai-elements` — load before any chat UI work.
