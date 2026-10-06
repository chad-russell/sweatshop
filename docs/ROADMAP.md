# Roadmap to go-live

Go-live = Chad does his daily work in sweatshop instead of dsh. Drafted
2026-10-06 from Chad's list plus the open follow-ups scattered through
docs 0006–0019. Each item that is architectural gets a numbered design doc
(0020+) before code, per AGENTS.md. Status: **draft, not yet reviewed with Chad.**

Legend: 🔴 blocks go-live · 🟡 should land before or soon after · ⚪ later / optional.

## Chad's list

### A. Final machine catalog 🔴
Today's rows: `think`, `ticket`, `smoke` (live DB; seeds only cover `think` and
`ticket`). `smoke` is a test fixture, not a catalog entry.

- Decide the real set of machines for daily work (candidates to discuss:
  ticket/feature, bugfix, PR review, research/think, chore/dependency bump,
  homelab change). Each: purpose, stages, which harness/model, human gates.
- Review `ticket` against real use: prompts, branch convention, `maxVisits`,
  whether verify should run the project's own test command, publish step.
- Retire `smoke` (or keep as a test-only seed outside the catalog); make the
  seeds the single source of the shipped catalog.
- Sequencing: **after B**, because definitions will carry fallbacks.

### B. Harness fallback and run overrides 🔴 (design doc 0020)
Two mechanisms, probably both:

1. **Static fallback chain in the stage definition** — e.g.
   `fallback: [{ harness: "pi", model: … }]`. The interpreter advances down
   the chain on a classified failure (credit/quota/rate limit/auth), not on
   ordinary task failure. Needs a failure classifier; `harness-limits` and the
   session-limit pending-input kind are the nearest existing seams.
2. **Per-run overrides at start** — `startRun({ overrides })`: global
   (`harness`, `model`) and/or per stage. Surfaces: composer target picker,
   `POST /api/machine-runs`, `start_machine` tool, and a "retry this stage with…"
   action on a parked/failed run.

Design questions: the run snapshot must record what actually ran (and why it
fell back); 0009 says each visit is fresh, so handoff between harnesses is
"restart the visit", not resume; `agent` stages are GLM-only today, so their
fallback is a model, not a harness; does a fallback also cover chat's `pi` /
`claude` tools; visible banner on the run when a fallback fired.

### C. Hindsight memory integration 🟡 (design session → doc 0021)
Chats, machine runs, and project knowledge participating in one global memory.
Agenda for the design session:

- **Banks**: one global bank vs per-project vs both (recall from several). Note
  the existing dsh plugin already writes `coding-agent::<repo>` banks, and bank
  ids with `::` must be URL-encoded or a NEW bank is silently created.
- **Retain**: what and when — chat turns (batched at turn end, like titles),
  run stage outputs, finished-run summaries, PR URLs/decisions. Use stable
  document ids so retries are idempotent; tag with project / conversation / run.
  Failures never block the turn (same invariant as 0002).
- **Recall**: auto-inject at turn/stage start vs an explicit `recall` tool vs
  both; budget; how it appears in the transcript (credited 🧠 block?).
  `reflect` as a tool for the agent.
- **Overlap**: dsh sessions and sweatshop chats about the same repo — avoid
  double-ingesting the same facts; decide which system owns which bank.
- **Cost/limits**: server throttles (mental-model refresh floor, 2 concurrent
  reflects); the extraction LLM is the cost driver. Machine runs are chatty.
- **Safety**: sandbox env/secrets must never reach retain; scrub rules.
- **Testing**: mock Hindsight client so tests never hit the server.
- Whether go-live waits on it: proposal below is retain-only before go-live,
  recall after.

### D. VM-based sandboxes (BoxLite) 🟡 (spike, then doc 0022)
Candidate: [BoxLite](https://github.com/boxlite-ai/boxlite) — daemonless
micro-VM runtime, Apache-2.0, runs OCI images, Node SDK
(`@boxlite-ai/boxlite`), needs `/dev/kvm` (present and world-writable on bee
and bees). From its README: per-box QCOW2 disk that persists across
stop/restart, clone and `.boxlite` export/import, volume mounts, local port
forwarding, `allow_net` egress allow-list, secret injection where real values
never enter the VM, CPU/memory limits.

Why it fits: enforces `network_policy` (0013, recorded-only today); clone is
the "fork instead of attach" follow-up; it is the VM tier 0004/0017 anticipated.
What the spike must answer, because today's design leans on podman networking:
- **Reachability**: the claude bridge, the preview proxy and `${service:…}` all
  reach containers by name on `sweatshop-harness`. A VM has no podman network
  membership — port forwarding/tunnels, or keep services as sibling containers
  and route through the host.
- **Services**: sibling service containers (0017) vs services inside the VM;
  `canRunServices` is the capability seam.
- **Exec semantics**: the harness adapter needs real streaming spawn and
  `docker exec -e` style env; check the BoxLite exec API against `toSandboxSession`.
- **Images**: existing `localhost/sweatshop-sandbox` and per-project images
  (nix, flutter, rust — see parity audit) must run as OCI images, plus pull/cache cost.
- **Lifecycle**: stop/resume, reaper, detached boxes outliving Next restarts.
- **Maturity**: Node SDK stability, boot time, memory overhead on bee.
Deliverable: a `BoxliteProvider` behind the existing `SandboxProvider` seam,
chosen per sandbox config, podman kept as the fallback tier.

### E. Agent-tool audit: configure everything by chatting 🔴 (audit, then doc 0023)
Goal: a top-level chat agent can set up and curate the whole system. Today's
agent tools cover machines (`list/get/create/edit/delete_machine`), runs
(`start_machine`, `inspect`), sandboxes (`sandbox_exec`), previews (5 tools),
`create_pr`, `ask_chad`. The HTTP API already exposes much more with no tool:
- **Projects**: create/rename/delete, repos add/remove, sandbox-config pick,
  branches listing (`/api/projects/*`). Project creation and sandbox configs
  are still `npm run db:seed` only.
- **Sandbox configs and credentials**: no tools (secrets must stay out of the
  model's context — design that, e.g. reference by name, never by value).
- **Sandbox lifecycle**: stop/destroy/reap (`/api/sandboxes`), attach.
- **Conversation organization**: folders, move, archive, trash, rename.
- **Run control**: cancel/retry, answer a human gate (inbox is UI-only).
- **Settings**: default model, reaper windows, themes.
Audit method: enumerate every mutating route/store function, mark which have a
tool, and check each existing tool for value-shaped errors, `baseVersion`-style
conflict handling, approval gates on destructive ops, and tests. Also decide
the principle: tools and UI call the same core functions (as 0015 did for machines).

### F. Review, evidence and delivery tooling 🟡 (design session → doc 0024)
Agents should verify and present their own work, not just push a branch:
- **Browser + screenshots**: a headless browser in sandbox images (chromium +
  playwright) with a `screenshot`/`browse` tool for chats, agent stages and
  harness stages; works against the preview URL.
- **Test running as a first-class step**: per-project test/lint/typecheck
  commands stored in project config (like the preview setup), run by a tool or
  a `verify` stage, with structured results rather than scraped bash.
- **End-of-run report**: a stage output that is an artifact — HTML (or markdown)
  with findings, diffs, test results, screenshots, preview link, PR link —
  stored with the run (SQLite + S3 per the persistence north star), rendered
  inline on `/r/<runId>` and in the Inbox card. The existing household
  `design`/`artifacts` skills are prior art for look and publishing.
- **PR quality**: PR body generated from the report, PR checks surfaced, review
  comments fed back into a fix stage.
Design questions: report format and sanitization (agent-authored HTML must be
sandboxed/iframed), where screenshots live, who captures them, size limits.

## Known open items (from the docs and the code)

### Go-live readiness 🔴
- **Run mode**: the app runs as an attached `./dev` dev server. Daily use needs
  a supervised service (quadlet/systemd unit, restart on boot/crash, ideally a
  production `next build`). The reaper, preview proxy and follower tick all live
  in that process, so its uptime *is* the product's uptime.
- **Backups**: confirm `data/sweatshop.db` (+ WAL) and `.workflow-data` are in
  bee's restic path; today only hand-made `.bak` copies exist. Workflow state
  durability across restarts needs a deliberate check.
- **Live DB state**: 0019 notes say migration 0032 was not yet applied to the
  live DB at the time; verify and apply (`./dev exec -- npm run db:migrate`).
- **Triage of existing runs**: 1 `needs-attention`, 2 `failed` runs — find out
  whether they are product bugs.
- **Daily-driver parity audit vs dsh**: done 2026-10-06, see the section
  below. Its findings feed the items in this file.

### Machines / harnesses 🟡
- Show a run's sandbox on `/r/<runId>` and the sandbox chip on the pi/claude
  session page (0011).
- Harness tool-approval cards instead of bypass (0006/0009).
- Cursor as a third harness (0006 review question 1).
- Parallel branches/fan-out, schedules as triggers, cross-stage harness resume
  (0009 out-of-scope list) ⚪
- Agent edits to a machine proposed on-canvas for accept/reject (0015) ⚪
- Usage/cost visibility per run and per provider — needed to make fallback
  decisions, not designed yet.

### Sandboxes / previews ⚪
- Enforce `network_policy` (recorded only today) (0013).
- Fork-instead-of-attach, opt-in git worktrees, parallel harness calls (0013).
- Push webhooks for immediate follows; preview per PR from `create_pr` (0016/0017).
- VM tier and external sandbox providers; service data snapshots (0017).
- Harness SSE replacing `/h` polling (0006).

### Security 🟡
- LAN/Nebula-only today. A real auth verifier is a hard prerequisite for any
  internet exposure (phone access off-Nebula, public share links).

## Parity audit (2026-10-06)

Method: decoded all 733 dsh sessions in `/var/lib/dsh/sessions` (26 working
directories) and counted tool calls, skills, bash commands, models and prompt
shapes. This is how you actually work, not how the app assumes you do.

**What the data says**
- **Most work is delegated factory work, not chat.** 73% of sessions are
  subagents (delegation depth ≥1); the median session is one turn. The prompts
  are worker briefs: "you are the build worker for DoD-N", "independent
  reviewer (did not author it)", "research worker, read-only, write only
  under research/…". Hod, seddit, dsh-satellite and bubblebox are all run as
  factories with a primary agent that fans out and gathers.
- **Heaviest tools**: bash 35k, edit 12.5k, read 11.5k, write 3k, grep 2k,
  todo_write 1.5k, web_fetch 1.5k, send_message/subagent/job_output/
  list_agents ~2.8k together, hindsight_* ~1k, skill 346, web_search 340,
  create/update_goal ~400, present 214, ask_user_question 123.
- **Toolchains in the work**: git, nix (2k `nix develop` calls: hod), cargo
  (hod, seddit, 3.6k), flutter/dart (satellite), podman, npm/pnpm, curl.
  Tests ran in 230 sessions; a browser/screenshot appeared in 72.
- **Models**: glm-5.3 dominates. Employer work (biblica-qr, open-bible, thi,
  360-*) runs on the gloo route: gpt-5.6-sol, gpt-6-sol, claude sonnet.
  Others via 9router (`cx/`, `or/`).
- **Skills actually loaded**: systematic-debugging (68), homelab-ops (43),
  proton-pass (37), design (30), biblica-qr-development (25), artifacts (10),
  refactor-checklist (9).
- **Outside software**: homelab/nix deploys (81 sessions), SSH to other
  hosts (52), pass-cli (29), forgejo API (59), and a handful each of monarch,
  home-assistant/roku, comfy, llama.

**Gaps this exposes** (the bold ones are new to the roadmap)
1. **Fan-out/parallel stages** — bubblebox's 3-agent batches and the
   seddit/hod worker swarms are the core pattern; 0009 lists fan-out as out
   of scope. Promote it. 🔴
2. **Independent reviewer stage** — fresh context, read-only, "did not author
   this", result gates the merge. Machine kind or stage option. 🔴
3. **Delegation inside chats** — chats have no subagent, background job,
   send_message or goal/todo tools; the top-level agent in E needs them. 🟡
4. **Web search and fetch** — 1.8k calls; absent from sweatshop chats. 🔴
5. **Model/provider breadth** — chat offers two GLM models; no gloo/employer
   route, no gpt/claude choice outside the claude harness. Needs a provider
   registry (9router is already the household broker). 🔴
6. **Project environments** — sandbox image is node-only. Hod needs nix, satellite
   flutter, seddit rust (all with "no host installs, containers only" rules).
   Per-project `image_ref` exists; the missing piece is an image build/curate
   story and reaching it from the audit tool in E. 🟡
7. **Rules and skills in sandboxes** — repo `AGENTS.md` reaches a harness only if
   its CWD loads it; household skills and the user-global layer do not. Decide
   what a worker sees. Also the "orchestrator commits, workers never push" rule
   some projects use vs the ticket machine's commit-and-PR flow. 🟡
8. **Secrets** — proton-pass is used in 29 sessions; sandboxes only have git
   creds. Pairs with the credential design in E. 🟡
9. **Scope decision**: homelab/nix deploys, other-host SSH and household
   (monarch, home-assistant, comfy) probably stay in dsh. Sweatshop is the
   software factory. See the open question below. 🔴
10. **Phone access** — dsh-satellite exists because Chad wants a mobile client;
    sweatshop is LAN/Nebula-only with no auth. Needs the verifier before
    anything off-Nebula. ⚪

**Not found**: schedules/cron triggers (a few ralph/workflow sessions only), so
those stay deferred.

## Proposed order

1. **Readiness basics** — run mode, backups, live-DB check, run triage. Small, unblocks everything.
2. **Parity audit** — done; confirm the scope decision (item 9) and the 🔴 gaps with Chad.
3. **B: fallbacks + overrides** — design doc 0020, then build.
4. **C design session** — doc 0021 (can overlap with 3; design only).
5. **E: tool audit** — prerequisite for setting up the catalog by chat; then **A: machine catalog** (including fan-out and reviewer patterns) with fallbacks in place.
6. **Go-live gate** — Chad works in sweatshop for a trial week with dsh as the escape hatch; record friction.
7. **C implementation** — retain first (can ship before the gate), then recall/reflect.
8. **F (review/evidence tooling)** design and build; **D (BoxLite)** spike in parallel, adopt only if the reachability questions resolve.
9. Remaining 🟡 items by friction observed in the trial.
