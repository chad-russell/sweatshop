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
   that touches that host uses it, no per-config wiring. Keep an explicit
   per-repo override for edge cases (two GitHub accounts). This is a
   slight re-statement of "referenced by our sandbox configs" that removes
   bookkeeping; the pluggable seam is unchanged.
2. **Fresh clone per conversation.** Because sandboxes are session-owned,
   each conversation in a project starts from a clean clone of the
   project's repos at `/workspace/<repo>`. That is *why* parallel work
   can't collide, and it means no cleanup discipline. Cost: clone +
   dependency-install time per conversation (see open question 2).
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

- **Phase A — infra spike (no schema, no UI).** Podman socket → eve
  Docker sandbox boots inside our dev container; a hardcoded selector
  opens a sandbox from the shared image and clones one scratch repo; the
  agent's bash tool runs `git log`. Go/no-go on the whole plan.
- **Phase B — entities + GitHost.** Schema/migrations
  (projects/project_repos/sandbox_configs/git_credentials) + seed script;
  `GitHost` interface + github/forgejo `installAuth`; selector resolves
  project → config → repos → credentials and injects auth; verified with
  a real push to a scratch repo.
- **Phase C — session binding + UX.** `x-sweatshop-project` header →
  principal → selector; `conversations.project_id`; conversation-in-
  project flow in the UI; project grouping in the sidebar.
- **Phase D — PRs.** `createPR` on GitHost implementations.
- **Later (recorded direction, not scheduled):** web config UI;
  agent-managed entities through tools; per-project Dockerfiles; warm
  cross-session caches via a custom sandbox provider; subagents sharing
  a parent sandbox; coding harness/skills.

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
