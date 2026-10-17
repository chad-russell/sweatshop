# Roadmap to go-live

Go-live = Chad does his daily work in sweatshop instead of dsh. Drafted
2026-10-06, revised the same day after an interview with Chad (decisions
below are his). Each architectural item gets a numbered design doc (0020 is Phase 0; 0021 providers)
approved before code, per AGENTS.md. Numbers are provisional.

Legend: 🔴 on the go-live floor · 🟡 soon after / during the trial · ⚪ later.

## Decisions recorded (interview, 2026-10-06)

**Scope and posture**
- Sweatshop starts as the **software factory**; homelab follows soon, treated as
  ordinary projects (NixOS and Fedora bootc config are just repos). Household
  tasks (finance, smart home, image generation) stay in dsh for now.
- **No work/personal distinction** except model selection, built as
  composably and agnostically as possible. Most of Chad's work is employer
  projects (polymer, gpl, qr-codes, open-bible) plus hod. No fencing or egress
  limits beyond today's behavior.
- **Dogfood target**: an employer project (open-bible or qr-codes), which
  exercises gloo models immediately.
- Evidence from 733 dsh sessions: 73% were subagents, the median was one
  turn, and web search/fetch was used ~1.8k times. See "Parity audit" at the end.

**Machines and async**
- **No fan-out/parallel stages.** Machines run asynchronously as tool calls; an
  agent that wants several starts several and tracks them. Machines stay linear.
- **No reviewer stage kind.** Independent review is a machine in the catalog
  (fresh context per visit is already the behavior).
- **No generic subagents.** Only machine runs and harness calls (pi / claude /
  cursor) can be started in the background from a chat. Completion **auto-wakes
  the chat with a new turn**; `inspect` covers explicit check-ins (0022 chose
  no separate wait/status tool — the wake is the wait).
- **Catalog** for go-live: Ticket (reworked), Bugfix, Independent review,
  Think-it-through. Not now: research, chore/dependency, factory orchestrator
  (the async work makes the orchestrator possible later).

**Models, providers, fallback**
- Providers are **native per vendor**: GLM (Z.AI, existing), **Gloo**,
  **OpenRouter** (each with its own key). Cursor is a third-party harness.
- Model choice is one **route** value = `{harness, provider, model}`, layered:
  run override > stage > project default > global default. Stages, projects and
  fallback chains all hold the same shape. claude/cursor are subscription
  harnesses (not provider-routed; model still selectable); projects may
  restrict allowed providers/harnesses (0021).
- **Sweatshop stays generic** (Chad, 2026-10-07): no "work" or employer
  concepts in the app; workflow fit comes from configuration.
- **Fallbacks**: a static chain on the stage, switching automatically on
  quota/credit/auth/rate-limit errors only (not task failures), with a visible
  banner and a record of what ran and why.
- **Cursor** (`@ai-sdk/harness-cursor`, ACP): ~~needs a user API key~~ —
  superseded 2026-10-11 by docs/0038: the browser-login `auth.json` works
  headless through the adapter (spiked). Design awaiting approval.

**Sandboxes, secrets, skills**
- **Sandbox image: image ref only** (public image or locally built), exposed in
  settings so nix/rust/flutter images are easy. No in-app build subsystem.
  Caveat: a locally built image lives in bee's podman; a VM runtime would need to
  pull or import it.
- **Secrets are an entity**, with their own sidebar page next to Machines and
  Sandboxes. No Proton Pass (or any provider) dependency: a pass-cli token is
  just a secret you store, which the sandbox then uses to reach Pass. Design:
  values encrypted at rest in SQLite with a key from `.env.local`; write-only in
  UI and tools (agents see names, never values); granted to **projects** first,
  per-stage narrowing later (that is the least-privilege stretch goal); delivered
  as a **per-command env var** by default, optional file-at-path for credential
  files; **stored events and transcripts redact** granted values. Git host
  credentials fold in as a secret type later.
- **Skills are an entity too**, but the source of truth is **files in the repo**
  (`skills/<name>/SKILL.md`), vendored in git; the DB holds only grants, to
  projects and machines. The user-global instruction layer is one more grantable
  item. Origin can still be the Forgejo skills repo, copied in.

**Memory (Hindsight)**
- One bank per project, **shared with the dsh-written `coding-agent::<repo>`
  banks**, plus a global bank for cross-project facts. Design session still owed.

**Operation**
- Run mode: **production build as a systemd/quadlet service on bee**, managed
  from cn like hindsight; `./dev` stays for working on sweatshop itself.
- Setup agent: **any chat**, with management tools always present (like the
  machine tools, 0015). Approvals only for destructive and secret-related ops.
  No audit log.
- Harness set (`@ai-sdk/harness` 1.0.132 plus pi/claude adapters) gets
  **one deliberate upgrade** before Cursor is added.
- Reports: **deferred past launch**. See Phase 3 (artifacts).

## Go-live floor (Chad's selection)

1. Web search and fetch tools
2. Provider breadth (Gloo, OpenRouter) and the route setting
3. Async machine/harness runs with auto-wake
4. Sandbox image in settings
5. Final machine catalog (4 machines)

Not selected but in my plan as prerequisites or immediate followers, flagged
for Chad to confirm: **supervised run mode** (Phase 0, since the daily tool
cannot depend on a terminal), **backups of the DB** (Phase 0), **fallbacks**
(Phase 2, first item: it's cheap once routes exist and your original ask),
and **secrets** (Phase 2; employer repos already work through git credentials,
so pass-cli is the first real need).

## Phase 0 — Readiness 🔴

Done 2026-10-07: live DB verified (33/33 migrations, no drift); the 3
bad runs triaged (all 2026-10-01, before `bcb73df`; no action); `smoke`
deleted; the test executor's 1.2 GB leak fixed (a73f8e3); a dev reaper
stuck on a pre-migration module found and restarted.

Production run mode + backups (0020): **live 2026-10-07.** One
`sweatshop` service on bee serving a production build; deploys via
`scripts/deploy.sh`; state in `data/` (restic + 23:00 snapshot). Phase 4
**verified 2026-10-07**: `ss/sweatshop/data` is in bee's restic
staticPaths; NAS snapshot `fdbd05e2` (00:03 that night) contains
sweatshop.db + WAL, the workflow-data tree (508 files), and
backups/nightly.db — contents checked, not exit codes.

## Simplification pass (doc 0031) — done 2026-10-08

Shipped as one PR with sequenced commits (#31): dropped
0011 per-call attribution (bindings answer it), fold `sandbox_configs`
into `projects.image_ref` (simplifies 1.4), collapse reaper windows to
one pair, dedup the two provisioning paths and the two harness-turn
engines, demote the machine canvas to a read-only viewer (editing =
JSON tab + agent tools). Keep list and details in 0031. Follow-on: doc
0032 (eve remnants — the `conversation_events` mirror, its importers, the
eve-era inbox fold) — done 2026-10-07.

## Phase 1 — The floor 🔴

Order matters: 1.1 → 1.2 feeds 1.3 and 1.6; 1.4 and 1.5 are independent.

**1.1 Harness upgrade (prep) — done 2026-10-08.** The bump widened into a
full AI SDK stack alignment (harness 1.0.141 pins provider-utils 5.0.56 /
ai 7.0.130 exactly, forcing the line): workflow 2.0.62 ↔ ai 7.0.130 ↔
provider-utils 5.0.56, harness 1.0.141, harness-pi 1.0.143,
harness-claude-code 1.0.145, pi-coding-agent 0.85.1 (still latest). Gate
green; live pi smokes on glm/gloo/openrouter and a live claude turn
passed. Ready for Cursor whenever a key exists.

**1.2 Providers and routes (doc 0021) — implemented 2026-10-08.** GLM, Gloo,
OpenRouter as providers for chats, agent stages and pi; one route value
resolved run → stage → conversation → project → global; per-surface
defaults on a new `/settings` page (swap test vs real models in one
place); projects may restrict their allowed providers and harnesses.
claude and cursor are subscription harnesses (vendor ToS): never
provider-routed, but their model is chosen per route. Everything else
defaults to pi. Generic: no work/personal concept in the app.

**1.3 Async runs with auto-wake (doc 0022) — implemented 2026-10-08.**
`start_machine` records the parent chat and wakes it when the run
settles (steer if mid-turn, a new turn if idle — a "[run …]" message,
chip-rendered); pi/claude chat calls are background harness-call
workflows returning handles, woken the same way on completion/failure;
`cancel_run` stops runs and calls; a 30 s sweep makes wakes
crash-safe. No `wait` tool (the wake is the wait; `inspect` for
check-ins), no fan-out — per the decisions below and 0022's YAGNI list.
Follow-up from the first live test (2026-10-07, no design doc — bug fixes
plus a polled status): the turn's durable stream now spans the whole turn
(slices no longer close it), a first send no longer blanks the fresh page,
run and background-harness cards poll their child's status, and
`create_machine` is approval-gated. pi/claude stay project-chat-only and
there are no inline (unsaved) machine definitions — the agent picks an
existing machine or calls a harness directly. Also shipped: the harness
session page shows the task each turn was given.

**1.4 Sandbox image in settings.** Partly landed via 0031: the image is
`projects.image_ref`, editable on the project page. Remaining: an agent
tool for it, validating the image is pullable/present, and showing
which image a sandbox ran. Check that harness bridges (claude's `pnpm install`
bootstrap, non-root `sandbox` user, `bash`) still work on arbitrary images and
document the image contract in `Containerfile.sandbox`. Ship example images
for nix (hod), rust, flutter.

**1.5 Web search and fetch (small, can be first) — implemented 2026-10-08.**
`web_fetch`: plain HTTP GET, redirects followed, 2 MiB download cap and
a 60 k character context clip, HTML stripped to readable text by regex
(title kept), textual content types only, value-shaped errors.
`web_search`: Z.AI's coding-plan MCP tool, verified live before
building — endpoint `https://api.z.ai/api/mcp/web_search_prime/mcp`
(Bearer `ZAI_API_KEY`; initialize returns an `mcp-session-id`, responses
are always SSE, the payload is a JSON string of the hits array parsed
twice). Hand-rolled two-call JSON-RPC over `fetch` — no SDK dependency,
so no Brave/Exa fallback needed. Both tools live in every chat and in
agent stages (`harness tools bring their own` holds — pi/claude are
untouched); failures are values; descriptions and the turn instructions
frame web content as untrusted; designed transcript cards
(`components/ai-elements/web-cards.tsx`) like the machine tools.

**1.6 Machine catalog (doc 0023) — implemented 2026-10-08.** Four
machines, seeds as the catalog: `ticket` reworked (three-way approve
gate — Approve / Revise-with-comment → re-plan / Reject; verify runs
the project's test command; branch naming = prompt ticket key >
project prefix > `<type>/<slug>`), `bugfix` new (reproduce RED →
diagnose → gated fix → verify green → publish, mirroring
systematic-debugging), `review` new (one fresh-context read-only
agent stage, PASS/FIX + findings, route inherited so employer
projects review on gloo), `think` kept. Substrate:
`projects.test_command` + `branch_prefix` (migration 0041, project
page "Work defaults" card, stage briefs' "# Project" section) and
`seed.mjs --replace` (catalog swap mode; run once at the deploy).

**Trial week.** Chad works in sweatshop on an employer project (open-bible or
qr-codes), with dsh as the escape hatch. Record friction in a file; it drives
Phase 2/3 ordering. Underway 2026-10-08 on GPL (TangoGroup); its first
frictions already shipped fixes: 0033 agent setup powers — gh + forgejo
repo discovery on the stored credentials, project tools
(create/edit/list/delete_project), and the New-project UI (sidebar +
⌘K) — all sharing the createProject core.

## Phase 2 — Foundations of the "just chat to set it up" world 🟡

**2.1 Fallbacks and run overrides (doc 0024).** Static chain on the stage's
route; a failure classifier (credit/quota/auth/rate limit); banner on the run;
snapshot records the route actually used and why. Overrides at start
(`startRun({overrides})`: global and per-stage) across composer picker, API,
`start_machine`, plus "retry this stage with…" on a parked/failed run. Visits
are fresh by design (0009), so handoff means restarting the visit.

**2.2 Secrets (doc 0025).** As decided above. Sidebar page, store with
encryption, grants on projects, per-command env delivery in the sandbox exec
seam (`SandboxHandle.run` already takes env), file-at-path option, redaction
in `harness_events`/messages, tools that manage secrets with value-blind
shape and approval. Stretch: per-stage grants (least privilege); folding git
credentials in.

**2.3 Skills (doc 0026; the thread half shipped as 0039 — playbooks
folded in: `skills/<id>/SKILL.md` with `thread: true`, `lib/skills.ts`,
`use_skill`, `?skill=`).** `skills/` directory in the repo, a loader, grants to
projects and machines, mounting a granted skill into the sandbox where the
harness looks for skills (check each harness: pi, claude, cursor each have
their own skill/rules convention), agent tools to read and (with a commit)
edit them. Decide what ships in the repo first (design, systematic-debugging,
refactor-checklist, forgejo-pr are the proven set).

**2.4 Tool audit (doc 0027).** After 2.2 and 2.3 and 1.4 exist so the new
entities are covered. Enumerate every mutating route/store function, mark which
have an agent tool, and close the gaps: projects (create/rename/delete, repos),
sandbox configs, secrets, skills grants, sandbox lifecycle (stop/destroy),
folders/archive/trash, run control (cancel, answer gates), settings. Principle:
UI and tools call the same core function (the 0015 pattern). Check existing
tools for value-shaped errors, conflict handling, approvals on destructive
ops, and tests.

**2.4b Agent instructions (design session).** The chat turn's instructions
are three lines plus tool descriptions; the 2026-10-07 async test showed the
agent improvising (a throwaway machine standing in for pi, a pass reported
on a substitute) where it should have stopped and said what was missing. One
guardrail line and an approval on `create_machine` went in as a stopgap. Do
this properly alongside the tool audit: what the agent should know about
its own surface (which tools exist where and why), when to ask vs act,
reporting honestly what actually ran, and per-surface instructions (chat,
agent stage, panel) instead of one string.

**2.5 Hindsight integration (design session → doc 0028).** One bank per
project shared with dsh, a global bank, retain from chats/run stage outputs/
finished-run summaries (stable document ids, never blocking a turn, secret-
scrubbed), recall by tool and/or injected at turn/stage start, mock client for
tests. Agenda carried from the first draft: bank id `::` encoding trap, overlap
with the dsh plugin (avoid double ingest), cost limits on the server, how
recalled memory is shown in transcripts. Retain can ship before recall.

## Phase 3 — Delivery tooling, VMs, more harnesses ⚪/🟡

**3.1 Artifacts and review tooling (design session → doc 0029).** Chad's
framing: a structured tool for agents to write static content (a file or a
folder) that sweatshop serves at a URL, like Claude artifacts, so an agent
can say "take a look at this" with nice HTML explanations, diagrams or
screenshots, and good instructions for how to produce them. Prior art: the
household `artifacts` and `design` skills. Includes a headless browser
(chromium/playwright in sandbox images) and a screenshot tool, project-level
test/lint commands as a first-class step with structured results, serving and
sandboxing agent-authored HTML (iframe/origin isolation, size limits), storage
(SQLite + S3 per the persistence north star), linking from run view, inbox and
PR body. Deferred past launch because it needs thorough design.

**3.2 Cursor harness.** *(Superseded by docs/0038 — not blocked; browser
login works. The text below is the original, key-based plan.)* Blocked on a user API key (Cursor Settings →
Integrations → User API Keys; may be unavailable under SSO — check with the
admin, or the ACP route could use an interactive login stored in the sandbox
image). The adapter installs the Cursor CLI in the sandbox with Cursor's
installer (needs network, one exposed TCP port), so consider baking the CLI
into the image. Needs 1.1 first.

**3.3 BoxLite VM sandboxes (spike → doc 0030).** `/dev/kvm` is present on bee
and bees; BoxLite is an embedded Rust runtime with a Node SDK, OCI images,
persistent per-box disk, clone, egress allow-list and secret injection. Spike
questions (it would replace podman networking assumptions): reaching the claude
bridge, preview proxy and `${service:…}` from outside a VM; services as
siblings vs inside; exec streaming and env semantics against the harness
adapter; locally built images; stop/resume/detach and the reaper; SDK maturity,
boot time, overhead. Deliverable: a `BoxliteProvider` behind `SandboxProvider`
with podman kept as fallback. Gains: enforceable `network_policy`, fork-via-clone.

**3.4 Homelab as projects.** Register cn, bootc configs and others as projects
with the right image (nix), secrets (host SSH, agenix handling), and skills
(homelab-ops, outage-triage). Mostly configuration once 1.4, 2.2 and 2.3 exist;
the open question is how deploys (`nixos-rebuild`, SSH to other hosts) run
from inside a sandbox safely.

**3.5 Remaining follow-ups** (from docs 0006–0019): sandbox chip on `/r/<runId>`
and the harness session page (0011); harness tool-approval cards (0006);
enforce `network_policy`; push webhooks for follows; preview per PR; VM tier
extras (0017); harness SSE; usage/cost visibility per provider/run.

## Polish backlog (Chad, 2026-10-16)

The system is proven; this phase is small improvements. Branch `glen/polish-agent-routing` carries items 1–6. Tick them here as they merge.

1. **AGENTS.md reaches every agent.** Live check (2026-10-16): pi and claude load nothing, and their cwd is the work root. Cursor loads no AGENTS.md, only the `.cursor/rules` from Chad's Cursor account. Fix: add repo AGENTS.md files to the top-level instructions, and write a work-root AGENTS.md/CLAUDE.md for the harnesses.
2. **Sandbox for repo work, host for live state.** With hosts configured, the agent ran repo work over `exec`. Fix: a routing rule in the instructions and the `exec` tool description.
3. **Host auto-approve toggle.** One toggle per chat that stays on until Chad turns it off; every command is still audited, and a card shows "auto-approved". Commands touching lockout-sensitive services still ask.
4. **Steer coding toward harnesses.** A prompt rule plus a line in the `bash` tool description. A reminder after N bash calls in a row is deferred until use shows it's needed.
5. **More than one harness per chat.** One active call per kind, max 3 at once. Every bridge uses fixed port 4000 and settled bridges keep holding it (seen live: cursor EADDRINUSE). Fix: a port per kind, and reap bridges when a call settles.
6. **Sidebar tree for parent/child chats.** Nest `start_thread` children under their parent (`parent_conversation_id`) with expand/collapse; a collapsed parent shows a running badge when anything under it is running.
7. **Context-window meter per chat** (not yet scheduled). Show how full the context is, as other harnesses do. Groundwork: `lib/providers/catalog.ts` already has each model's `contextWindow`; turn usage is not stored today. Needs: store each model step's `usage.inputTokens` (the last step's input tokens ≈ current context size) on the assistant row; a meter in the chat header (used / window, %, warning color near the limit); for harness calls, the harness's own usage per session if its events carry it. Open question: what happens when a chat nears the limit (warn only, or offer compaction / a fresh thread with a summary).
8. **Drizzle snapshot gap** (not yet scheduled). `drizzle/meta/` has no snapshots for 0048–0051, so `npm run db:generate` diffs against 0047 and tries to recreate those tables; 0051 was written by hand for that reason. Migrations themselves are fine (the runner reads only the SQL files + `_journal.json`; the upgrade from main was verified). Fix: regenerate a current snapshot from `db/schema.ts` so the next generate produces a clean diff.

## Open questions

- **Releases and migrations**: proposed in 0020 (deploy script:
  fast-forward, snapshot, stop, build + migrate, start).
- **Cost/usage visibility** per provider and per run, which fallbacks make more
  valuable; not designed.
- **Mobile access** (dsh-satellite exists because Chad wants a phone client):
  needs the auth verifier before any off-Nebula exposure.
- **Cursor key**: can Chad get a user API key under enterprise SSO?
- **Route in run snapshots** and how claude is pointed at the gloo Anthropic
  route (1.2 spike).
- **How skills reach each harness** (2.3 spike).
- **A default sandbox for every chat** (Chad, 2026-10-08): the
  has-sandbox/has-project tool split has bitten repeatedly (plain chats
  lack bash; the gh-vs-bash reasoning; preview tools). Explore giving
  top-level chats a default sandbox (no repos — an empty workspace) so
  the sandboxed toolset always exists and the split becomes "project
  repos or not". Questions: per-chat containers vs one shared scratch
  sandbox; reaper/lifecycle pressure; the 0013 binding model and the
  explicit "no sandbox" choice; cost on bee.

## Parity audit (2026-10-06)

Method: decoded all 733 dsh sessions in `/var/lib/dsh/sessions` (26 working
directories) and counted tool calls, skills, bash commands, models and
prompt shapes.

- **Most work is delegated.** 73% of sessions are subagents (delegation depth
  ≥1), median one turn. Prompts are worker briefs ("build worker for DoD-N",
  "independent reviewer, did not author", "research worker, write only under
  research/") across hod, seddit, dsh-satellite, bubblebox.
- **Heaviest tools**: bash 35k, edit 12.5k, read 11.5k, write 3k, grep 2k,
  todo_write 1.5k, web_fetch 1.5k, delegation/job tools ~2.8k, hindsight ~1k,
  skill 346, web_search 340, goals ~400, present 214.
- **Toolchains**: git, nix (2k `nix develop`), cargo (3.6k), flutter/dart, podman,
  npm/pnpm. Tests in 230 sessions; browser/screenshot in 72.
- **Models**: glm-5.3 dominates; employer work runs gloo/gpt-5.6-sol,
  gpt-6-sol, claude sonnet; some via 9router (`cx/`, `or/`).
- **Skills loaded**: systematic-debugging 68, homelab-ops 43, proton-pass 37,
  design 30, biblica-qr-development 25, artifacts 10, refactor-checklist 9.
- **Outside software**: homelab/nix deploys (81 sessions), SSH to other hosts
  (52), pass-cli (29), forgejo API (59); monarch, home-assistant, comfy a handful.
- **Not found**: schedules/cron triggers; stay deferred.
