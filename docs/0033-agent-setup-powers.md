# 0033 — Agent setup powers: gh + project tools

Status: **draft 2026-10-08 — Phase A pre-approved in chat (this PR ships
it); Phase B awaits approval.** Born from the demo week's first friction
(see docs/TRIAL-FRICTION.md): the GPL setup chat behaved correctly but
could only ask Chad to do the UI work.

## The model (Chad's, confirmed)

A setup chat is a **controller**: it helps find the repo, proposes the
project, creates it on approval, and hands off the `/?project=<id>`
link. It never becomes the project chat (0013: bindings are chosen at
creation). No rebinding, ever — a plain chat that gains a project is a
new conversation.

## The credential policy (the principle this doc establishes)

**The agent never touches secret material; it exercises capabilities
that are credentialed on its behalf.** Credentials live server-side,
resolve by host, and are delivered as env (never as values the model
sees). Two corollaries, written down honestly:

- In a sandbox, the boundary is the **token's scopes**, not any tool
  allowlist — once GH_TOKEN is in the environment, bash can curl the
  API directly. Read-scoped sandbox tokens are 2.2's least-privilege
  stretch goal, not a pretend boundary today.
- Git credentials fold into the 2.2 secrets entity as a secret type —
  gh delivery is the per-command-env pattern in miniature, not a
  second credential store.

## Phase A — gh for discovery (shipped with this doc)

**A `gh` tool in every chat** (and agent stages), running the real
GitHub CLI in the app container with the stored `github-chad`
credential's token as `GH_TOKEN`:

- Verified before designing: the existing token already sees private
  `TangoGroup/360-gpl` (HTTP 200; authenticated search finds it) — no
  new credential, no scope change.
- **Read-only allowlist of command paths** (`repo list/view`, `search
  repos/code/issues/prs/commits`, `pr list/view/checks`, `issue
  list/view`, `release list/view`); anything else is a value-shaped
  refusal. `gh api` is deliberately excluded (it can POST).
- Args pass as an argv array (no shell); output clipped; the token
  never appears in results; no credential → `not-configured`; no
  binary → `gh-not-installed`.
- The app image gains gh (pinned v2.102.0 .deb); the sandbox image and
  in-sandbox `GH_TOKEN` delivery land with Phase B / 2.2.
- Forgejo keeps the seam verbs (`listRemoteBranches`, `createPR`) —
  CLI parity only if friction asks for it.

## Phase B — project-management tools (awaiting approval)

The first slice of the 2.4 tool audit. UI and tools call the same core
functions (the 0015 pattern):

- `list_projects` — read-only, ungated: id, name, repos, defaults.
- `create_project` — id, name, repos[]; **approval-gated** like
  `create_machine` (a durable entity is Chad's call). Repos are
  validated against hosts the credentials resolve. Optional at
  creation: default route, test command, branch prefix, image.
- `edit_project` — repos with the UI's guarded-removal semantics,
  work defaults, models-card fields, image. Benign fields ungated;
  repo removal carries the same blocker report the UI shows.
- `delete_project` — gated, with the cascade warning text (cancel
  live runs, destroy sandboxes, delete owned rows).

With A+B the GPL flow is one conversation: search the org, find
`360-gpl`, propose the project, one approval, create, hand off the
link.

## Non-goals

Forgejo CLI parity; read-scoped sandbox tokens (2.2); project-page UI
changes; conversation rebinding; write-path gh in the chat tool
(PR creation stays on the `create_pr` seam, which records properly).

## Phases

1. **A** — gh binary in the app image, the core + tool + step, docs
   update (`docs/agent/projects.md`: the agent can find repos itself),
   tests (allowlist, argv safety, clipping, not-configured, no-token-
   in-output).
2. **B** — the four tools over store cores (`db/projects.ts` already
   holds every write path), approvals, value-shaped errors, tests,
   docs update (the who-does-what table flips).
