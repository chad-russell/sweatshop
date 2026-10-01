# 0004 — Projects & Sandboxes (planning)

Status: **planned** — requirements and decisions locked with Chad
(2026-09-29). Implementation starts at Phase A (infra spike) on his word.
Out of scope for this feature: coding harness, coding tools/skills,
subagents, workflows.

## Vision

Use the chatbot to interact with multiple different projects in a nicely
sandboxed way: start a conversation in the context of a project's sandbox,
work on that project's repos — commits, pushes, PRs — with several
parallel conversations on the same project never stepping on each other.

## Requirements (as stated)

1. **Project** — an entity that breaks up types of work. Most projects are
   one git repo; some are several (e.g. a work project with separate
   frontend and backend repos). *A project is defined by a list of one or
   more git repos.*
2. **Sandbox config per project** — each project has its own sandbox
   config; a conversation starts "in" the sandbox of a particular project.
3. **Git credentials as first-class entities** — configured once
   (starting with GitHub and Forgejo) and referenced by sandbox configs so
   any sandbox can use them.
4. **Parallel isolation** — multiple simultaneous conversations inside
   multiple instances of the same sandbox config, totally separate.
5. **Orthogonality / pluggability** — future VCS integration goes through
   an interface/type that projects reference an implementation of —
   vercel-SDK style: documented, pluggable, separated concerns.

## What eve already gives us (all doc-verified)

| Need                              | eve mechanism                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Parallel isolated instances       | Sandboxes are **session-owned**: `environment.open()` starts one sandbox per durable session; 3 conversations = 3 sandboxes ([sandbox/index](../vendor/eve/docs/sandbox/index.mdx)) |
| Conversation → project binding    | The `defineSandbox()` selector receives `{ session }` and runs per session — it can branch on session context and open/configure accordingly ([sandbox/index](../vendor/eve/docs/sandbox/index.mdx)) |
| Agent runs git                    | The opt-in `bash` built-in tool runs commands in the session's sandbox (`agent/tools/bash.ts`, [built-in-tools](../vendor/eve/docs/concepts/built-in-tools.md)); `read_file`/`write_file` likewise |
| Local containers                  | `DockerSandbox` from a default image, OCI image, or Dockerfile; `DefaultSandbox` tries Docker → microsandbox → just-bash by host support |
| Per-session setup & secrets       | The selector may configure the sandbox after `open()` (write files, run commands) before returning it — per-session credential injection lives here |
| Reusable prepared artifacts       | Environment `prepare` bakes setup into a Docker image / VM snapshot / template shared by all sessions of that environment            |
| Lifecycle                         | Session sandboxes persist across turns; `stop()`/`delete()`; resume on reconnect                                                      |
| Later: subagents sharing a sandbox | `defineParentSandbox()` for declared subagents (explicitly out of scope now)                                                        |

The binding mechanism proven in the prototype: the channel admits callers
with attributes (ours already returns a synthetic principal), the browser
passes a project header at session creation, and runtime code
(selectors/hooks) reads it from `ctx.session.auth` — immutable for the
session's life.

## Proposed refinements to the requirements

1. **Credentials resolve by git host, not by sandbox config.** A GitHub
   credential matches every `github.com` remote; a Forgejo credential
   matches its instance host. Configure once — every project and sandbox
   that touches that host uses it, no per-config wiring. Multiple
   accounts per host are explicitly out of scope (single-user tool);
   if ever needed, host resolution gains scoping rather than per-repo
   overrides.
2. **Fresh clone per conversation.** Because sandboxes are session-owned,
   each conversation in a project starts from a clean clone of the
   project's repos at `/workspace/<repo>`. That is *why* parallel work
   can't collide, and it means no cleanup discipline. Known cost: clone +
   dependency-install (`npm install` et al.) per conversation — accepted
   for v1; if it bites, the two sanctioned remedies are per-project
   Dockerfiles baking deps (later) or warm cross-session caches via a
   custom provider (later).
3. **Sandbox configs are shareable first-class entities** (a table rows
   reference, not embedded config): most projects point at one personal
   default; a project *may* define its own. Matches the credentials
   philosophy.
4. **PRs/Pushes in two stages.** Push/commit/fetch is plain git inside the
   sandbox with injected credentials (no new code paths). PR creation is
   an API call — that arrives with the `GitHost` interface below, after
   the core loop works.

## Proposed architecture

### Data entities (sqlite, our store)

```text
projects            id, name, description, sandbox_config_id (nullable → default), created_at
project_repos       id, project_id, url, name (dir name), default_branch?, credential_id? (override)
sandbox_configs     id, name, provider ("docker" | ...), image_ref?, dockerfile_path?, network_policy, notes
git_credentials     id, kind ("github" | "forgejo"), label, username, secret, base_url? (forgejo), created_at
```

Conversations gain an optional `project_id` (bound at creation,
immutable — same rule as the session attribute).

### Code seams (the vercel-style pluggability)

```text
agent/sandbox.ts        the defineSandbox selector: resolve project from
                       session auth → load config + repos + credentials
                       from the store → open the right environment →
                       clone repos → inject git auth → set git identity
lib/git-hosts/          GitHost interface + github.ts + forgejo.ts
GitHost {
  kind: "github" | "forgejo"
  matchesHost(remoteUrl): boolean
  installAuth(sandbox, credential): Promise<void>   // git config / credential helper / ~/.netrc
  // later: createPR, listPRs, verifyCredential ...
}
```

The `GitHost` interface is the future VCS-integration seam: projects and
repos never know which implementation serves them; new hosts (gitlab…)
are a new file. Credential *storage* and credential *use* stay separate.

### Runtime flow

1. Browser creates a conversation "in project X" → `useEveAgent` sends
   `x-sweatshop-project: <id>` header → channel `lanAuth` lifts it into
   the principal attributes → conversations row gets `project_id`.
2. First sandbox access (agent uses `bash`/files) → selector runs:
   reads project → clones repos → injects credentials per host →
   returns configured sandbox. Sandbox persists for the session across
   turns.
3. Plain (non-project) conversations: no sandbox (or a minimal default —
   open question 4).

### Infrastructure note (podman-only rule)

The dev container must reach the host podman socket (sibling containers):
mount the rootless podman socket, set `DOCKER_HOST`. The Docker sandbox
provider then creates project sandbox containers as podman siblings.
This must be proven first (Phase A spike) — it is the riskiest unknown.

## Staging plan

- **Phase A — infra spike ✅ (2026-09-29).** Proven end to end: the dev
  container image now bakes the docker CLI (`Containerfile.dev` →
  `localhost/sweatshop-dev`; trixie's `docker.io` only *recommends*
  `docker-cli`, so it is named explicitly), the wrapper mounts the host
  rootless podman socket at `/var/run/docker.sock`, and the eve Docker
  provider — which shells out to `docker` — creates session sandboxes as
  SIBLING containers on host podman (observed: `eve-sbx-…` from
  `eve-sandbox-template:…`). Environment `prepare` baked git into the
  prepared image once; the hardcoded selector cloned
  `jonschlinkert/is-odd` into `/workspace/repo` and the agent ran
  `git log --oneline -5` through the bash tool, returning real commits
  (`a80ee0d 3.0.1`, …). Gotchas recorded: git prompts for credentials on
  a 404 repo (clone with `GIT_TERMINAL_PROMPT=0`); a selector throw fails
  every subsequent tool call at sandbox-bind time (bootstrap errors
  should be clear). **Go.**
- **Phase B — entities + GitHost ✅ (2026-09-29).** Schema (migration
  0002: `projects`, `project_repos`, `sandbox_configs`,
  `git_credentials`) + idempotent seed script (`npm run db:seed`,
  secrets only from env) + the `GitHost` seam
  (`lib/git-hosts/`: interface, remote parsing, ssh→https
  normalization, credential-store injection, host-scoped resolution;
  `github.ts`, `forgejo.ts`) + the project-driven selector. Verified
  live end to end: a fresh session's sandbox cloned BOTH spike-project
  repos (anonymous github + credential-authenticated forgejo — the
  forgejo credential seeded from the Proton Pass `git.crussell.io`
  item via a root-only temp env file, shredded after), then the agent
  created branch `sweatshop/sandbox-spike`, committed, and **pushed to
  git.crussell.io** — `git ls-remote` confirms matching SHAs
  (`b54a315`). 25 tests green (remote parsing, host scoping,
  credential-line encoding). Notes: git identity comes from
  `GIT_USER_NAME`/`GIT_USER_EMAIL` (defaults `sweatshop agent`
  / `agent@sweatshop.local`); GitHub has no credential yet (vault has
  none) — github auth is exercised whenever one is added via seed;
  `image_ref` on sandbox_configs is schema-ready but unused (shared
  base image, decision 2).
- **Phase C — session binding + UX ✅ (2026-09-30).** The channel lifts
  `x-sweatshop-project` into the session's initiating principal
  (immutable for its life); the sandbox selector binds from
  `session.auth.initiator.attributes.project` (selector context carries
  auth — verified against the 0.67.2 types) and throws a
  self-explanatory error for unbound sessions (decision 4: no sandbox
  without a project); the mirror stamps `conversations.project_id` at
  row creation only (never rewritten; FK to projects; 26 tests).
  UI: `/p/[projectId]` starts a bound conversation (ChatSurface sends
  the header on session creation; New chat resets in place within the
  project; 404s on unknown ids), and the sidebar groups conversations
  by project with the group header linking to the project page.
  Verified live: a bound session cloned both spike repos and read the
  scratch repo's real history (`bb3abdd base moves`); an unbound
  session's bash failed with the designed error and the agent explained
  it; db rows show `spike` vs `null` exactly per binding; `/p/spike`
  200, `/p/bogus` 404, sidebar renders the project group.
- **Phase D — provider actions as agent tools ✅ (2026-09-30).**
  `GitHost.createPR` (github Bearer, forgejo Basic — Forgejo accepts
  account password OR PAT via Basic; `Authorization: token` requires a
  PAT, which the vault item is not) + `repoPath` parsing + injected-fetch
  tests (31 total). `agent/tools/create_pr.ts` is the thin project-aware
  wrapper (project → repo → host-scoped credential → createPR).
  Verification history, accurately: the first live attempt 401'd
  (vault secret is an account password; `Authorization: token` needs a
  PAT) and the AGENT improvised a bash curl from the sandbox credential
  to open PR #29 — the tool did not create it. After the Basic-auth fix
  the tool retried into a correct 409-already-exists. The tool's first
  true success: PR #31
  (git.crussell.io/chad/sweatshop-e2e-scratch/pulls/31, branch
  `tool-verify/phase-d`, commit `e7b2460`) opened end-to-end by the
  tool. The underlying `GitHost.createPR` call was separately proven by
  the Path B pipeline's PR #30.

## Sandbox lifecycle findings (2026-09-30 experiments)

- Stopping a session's sandbox container is NOT a transparent pause: the
  next access re-runs the selector into a NEW container. Uncommitted
  worktree state is orphaned; pushed git state survives — git is the
  durable state, validated even here.
- Container names carry no session id (sha256 derivation ruled out, no
  env labels), so per-session cleanup is impossible → age-based reaping.
- `npm run sandbox:gc` (scripts/sandbox-gc.mjs): dry-run by default,
  `GC_APPLY=1` to remove, `GC_AGE_HOURS` cutoff (24h). Auto-detects
  docker (in-container, socket) vs podman (host). Agent instructions
  now direct prompt commit/push.
- **Later (recorded direction, not scheduled):** web config UI;
  agent-managed entities through tools; per-project Dockerfiles; warm
  cross-session caches via a custom sandbox provider; subagents sharing
  a parent sandbox; coding harness/skills.
- **Sandbox provider evolution (long-term direction):** migrate from
  Docker to real VMs — self-hosted, easier to back up/checkpoint/
  restore, and able to run docker inside. Three tiers behind the
  existing provider seam (sandbox_configs.provider picks per project;
  no schema change): Docker (today) → **microsandbox** (eve built-in:
  libkrun microVMs from OCI images, KVM hosts, snapshot-based session
  lifecycle = checkpoint/restore, DOMAIN network policies — finer than
  docker's allow/deny-all; prototype-proven on this hardware incl.
  in-VM installs and per-host egress control) → **heavy VM tier** (full
  guests via a custom `defineSandboxProvider` over cloud-hypervisor/
  QEMU on bees' KVM) for sandbox tasks that need docker-inside —
  unproven in libkrun microVMs; spike item. Infra notes: /dev/kvm
  passthrough into the runtime container; the AI SDK SandboxSession
  adapter and provisioner lib make the swap invisible to Path A/B.

## Path B shipped (2026-09-30, arc complete)

> **Superseded by 0009 (2026-10-09):** run_ticket became the seeded
> "ticket" machine; `workflows/run-ticket.ts`, `/api/tickets`, `/t` and
> `ticket_runs` are deleted. The notes below are historical.

`withEve(withWorkflow(...))` coexist cleanly (spiked with a hello
workflow). Version alignment matters: `@ai-sdk/workflow@2.0.53` pins
exactly the `provider-utils@5.0.51`/`ai@7.0.122` line the rest of the
app uses — a mismatched version nests a second provider-utils and
splits every tool type (fixed by choosing the matched build, not by
casts).

**run_ticket** (`workflows/run-ticket.ts`): raw Workflow SDK pipeline —
provision (step: `provisionProjectSandbox` from our own
`localhost/sweatshop-sandbox` image) → plan (WorkflowAgent +
`experimental_sandbox` over our adapter, bash tool reading
`options.experimental_sandbox`) → **approval gate** (`defineHook`,
token = ticketId; the run suspends and the UI resumes it) → implement →
QA → push → PR (`openPR` step, credential-matched repo). The workflow
transform enforces the discipline at build time: Node-touching code
lives only in `"use step"` functions (first attempt put `loadProjectPlan`
and adapter construction in the body — build error, restructured).

Status lives in `ticket_runs` (the db IS the run status): trigger
`POST /api/tickets`, poll `GET /api/tickets/:id`, approve
`POST /api/tickets/:id/approval`. UI: arrow button on the project page
opens the ticket dialog; `/t/[ticketId]` is the live run view with the
approval card.

**Verified end-to-end (2026-09-30):** trigger → plan (sandbox cloned
both repos) → gate suspension + approval resume → implement → QA PASS →
push → **PR #30 opened automatically**
(git.crussell.io/chad/sweatshop-e2e-scratch/pulls/30); run view shows
completed + PR link; workflow container cleaned up (0 strays); 31 tests
green. First run surfaced and fixed two real bugs: openPR must target
the credential-matched repo (repos[0] was the credential-less github
repo), and all-Node-in-steps (above).

## Day-to-day operation model (design note, 2026-09-30)

Where work happens is decided by **where the session is bound**, not by
the delegation syntax: root-copy children share the root session's
sandbox.

- **Project work starts from `/p/<id>`** (the operational home): the
  root session owns the project sandbox. Single-run work = the root
  working directly with bash, or delegating to the built-in `agent`
  tool (a root-copy child on the same tree, as a durable background
  task). Pipeline work = an authored `defineWorkflowTool` state machine
  (ctx.ask gates between phases, ctx.agent root-copies sharing the one
  tree; phase specialists with fresh clones where isolation is wanted).
  Both shapes coexist as tools; model/user picks per task.
- **The unbound main chat is the coordinator layer** — it has no
  sandbox and neither do its root copies. Bridging "paste a ticket in
  main chat → work happens on a project sandbox" is a later design
  item; the sanctioned mechanic is a custom tool that starts a new
  project-bound session via the local eve API (channel operations /
  session handles) and returns its conversation URL. Lineage-based
  specialist binding cannot work from an unbound parent (null
  project_id by definition).

## Two pipeline architectures (design note, 2026-09-30)

The raw Workflow SDK docs (docs/workflows/) show a second first-class
path: **WorkflowAgent** agents inside plain Workflow SDK workflows —
normal functions startable via `start()` from any API route, tool, or
button, with tools as durable steps, HITL via `defineHook`/
`createWebhook`, and chat sessions modeled as workflow-per-session with
resumable streams. No eve session is required for the pipeline.

**The raw SDK has no sandbox concept** (steps get host Node.js access;
neither doc mentions sandboxes) — on that path we own sandboxing. The
design unlock: extract provisioning from `agent/sandbox.ts` into a
shared lib (`provisionProjectSandbox(projectId)` → container handle,
reusing GitHost credentials + the Phase A podman plane), consumed by
BOTH paths.

- **Path A (eve-native, built):** conversation-centric. Session-owned
  sandbox; phases via `ctx.agent` (each a durable, mirrored, streamed
  eve session); `ctx.ask` renders in our existing chat UI. Cost: the
  one kickoff turn. Best when the conversation IS the surface.
- **Path B (raw SDK, future):** pipeline-centric. `start()` from a
  button/API/tool — zero agent-session shim; per-phase agents are
  `WorkflowAgent`s. **`WorkflowAgent` takes
  `experimental_sandbox: Experimental_SandboxSession`** (agent-level
  default + per-stream override, passed through to tool execution) —
  verified against @ai-sdk/workflow 2.0.49 types — so standard
  sandbox-aware tools (bash/read_file/write_file) work with NO custom
  wrapper tool. All phases share one sandbox by passing the same
  session. `Experimental_SandboxSession` is a small structural
  interface (description, file reads/writes, run/spawn) that eve's own
  docker bindings deliberately mirror; official provider packages are
  Vercel-hosted (cloud-only) or just-bash (no isolation), so the right
  implementation for us is a thin adapter over the podman container
  our provisioner creates — both paths then consume identical
  provisioned sandboxes. Caveat: `experimental_` prefix — pin versions
  and expect API drift.
- **Durability of the sandbox across suspensions:** a container is a
  poor durable object (would have to outlive multi-day HITL waits).
  The pipeline's true durable state is **git** — branch + commits are
  recoverable, so the sandbox can be ephemeral: provision at phase
  start (checkout the branch), destroy after; "durable sandbox"
  becomes "durable worktree via git." Keep-alive is the simple
  alternative when phases are chatty.
- Both paths share every lower layer: project entities, GitHost,
  credentials store, podman plane, model wiring. The choice is per
  work-type, not per system.

## Workflow invocation (design note, 2026-09-30)

**A workflow tool run is always owned by an agent session** — that is
where ctx.ask renders to the user, where task receipts and auth ride,
and (decisively for us) where sandbox binding lives. Direct
workflow-without-session invocation is not in eve's model, and for OUR
workflows the session is not a shim: it is the pipeline's addressable
surface (stream to watch, approvals to answer, URL to return to).

Consequences:

- **run_ticket cannot be called from unbound main directly** — its
  phases need the project sandbox, sandbox binding rides session
  creation, and an unbound session (and its ctx.agent children) have
  none. That is the isolation guarantee working, not a limitation to
  engineer around.
- **The invocation primitive is: project-bound session + kickoff
  message.** The kickoff costs one cheap model turn (flash) whose job
  is to call the tool — shaped deterministically by instructions
  ("first message = RUN_TICKET payload → call run_ticket verbatim").
  Everything durable after that is the workflow's.
- **Trigger surfaces all funnel into the same primitive**, and more
  than one is supported: (a) the bridge tool called by the model in
  unbound main; (b) a UI button calling the eve channel API directly
  (POST /eve/v1/session with x-sweatshop-project + kickoff message —
  no agent involvement at all before the kickoff turn); (c) schedules
  for cron-driven work. Unbound main never relays or hosts the
  pipeline — it drops a URL.
- Durable workflow state stays in eve's local world (`.workflow-data/`,
  file-backed — no postgres needed, consistent with the north star;
  `@workflow/world-postgres` exists and stays unused).

## Future composition notes (doc-verified 2026-09-30)

**Subagents × sandboxes.** Three delegation kinds, three sandbox
answers ([subagents doc](../vendor/eve/docs/subagents/index.mdx)):

- Root-copy children (built-in `agent` tool) **reuse the parent's
  sandbox** — an un-sandboxed root's copies are un-sandboxed too. No
  escape hatch into a project sandbox.
- **Declared subagents** (`agent/subagents/<id>/`) never inherit the
  root's authored sandbox — they author their own `sandbox.ts` (or use
  the framework default), or explicitly share the parent's via
  `defineParentSandbox()`. So an un-sandboxed coordinator root CAN
  spawn a project-sandboxed specialist. Binding design for that child:
  its selector reads `ctx.session.parent?.sessionId` and looks up the
  parent conversation's `project_id` in our store (the mirror already
  records it) — deterministic, no assumption about attribute
  propagation into child sessions. Verify attribute propagation when
  built; the parent-lineage path works regardless.
- **Remote agents** are separate deployments: their sandbox is entirely
  the remote's concern; identity can be forwarded
  (`forwardPrincipal`) but our project store does not reach them.

**Workflows × sandboxes.** Workflow tools
([workflows doc](../vendor/eve/docs/tools/workflows.mdx)) deliberately
have **no sandbox access** — `getSandbox` is unavailable in the
workflow body and in `"use step"` helpers (steps must stay replayable).
The Plan → Implement → QA shape composes instead:

- The workflow tool orchestrates (`ctx.ask` for approvals between
  phases, `sleep`/webhooks for waits, all durable).
- Each phase is `ctx.agent(target, { message, agentId?, outputSchema })`
  — a subagent invocation that IS a durable workflow operation.
- Sandbox topology per need: root-copy targets (`"agent"`) all reuse
  the root session's project sandbox — one shared working tree across
  phases (sequential phases can continue one `agentId`); declared
  phase-subagents get fresh isolated clones (e.g., QA against a clean
  checkout of what Implement pushed). "The sandbox resumes after every
  pending call in the current batch settles" — sandbox lifecycle is
  workflow-aware across durable suspensions.

## Decisions (2026-09-29)

1. **Management surface — seed script / db-first in v1.** Entities are
   rows created by a seed script (or direct db edits) until the flow is
   proven. Direction recorded for later: BOTH a web config UI and
   agent-managed config through tools are eventual requirements — the
   schema and GitHost seam are designed so both can sit on the same
   store without migration.
2. **Base image — one shared image first.** A single node-based sandbox
   image for every project; per-repo dependency setup happens per
   conversation. The `sandbox_configs` schema already carries an optional
   image ref so per-project Dockerfiles can arrive later without a
   migration.
3. **Credential secrets — plaintext column in sqlite.** Same posture as
   `.env.local` today: LAN-only personal tool, db gitignored, host-backed
   up. Reversible later via a re-encryption migration if exposure grows.
4. **Non-project conversations get no sandbox.** The agent stays
   conversational unless a project is bound; the bash tool exists only in
   project sessions.
