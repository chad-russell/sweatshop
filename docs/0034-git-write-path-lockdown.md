# 0034 — Git write path: brokered push, gated PRs

Status: **2026-10-08 — Phase A implemented in the approved final shape
(chat gate; propose_pr → human gate → deterministic publish stage;
edit_machine gated); phases B–E pending.** Born from the trial findings
in docs/TRIAL-FRICTION.md.

## Phase A as built — approval at each surface's native boundary

The rule that fell out of the design discussion: **approval happens
where the runtime can natively suspend.** For a chat turn that is
mid-turn (the ask_chad hook — the only agent context whose tool
executes run in workflow context). For a machine run it is the stage
edge (the human gate, 0009). Hooks may not be created inside workflow
steps (vendored HumanInTheLoop.md — steps are atomic journaled units;
only the body re-runs deterministically to an await), and every harness
or agent-stage tool executes inside a step — so no machine-context tool
can wait for Chad, and none needs to:

- **Harnesses hold no git write powers at all.** pi/claude in machine
  stages and agent-stage calls get `propose_pr` (records a run-scoped
  `pr_proposals` row with a summary rendered at propose time — commits
  + diffstat); chat harness calls get no git tool (the chat agent
  publishes with its own gated `create_pr` after the wake). Local git
  stays in sandboxes — status/diff/log is how coding agents read a
  repo; the boundary that matters is remote writes, enforced by phase
  B's read-scoped tokens.
- **The human gate is the PR gate.** A waiting gate's inbox card
  renders the run's pending proposal; Chad's transition choice IS the
  approval. No mechanism changes to gateHook — only card data.
- **`publish` is a new deterministic stage kind.** No model runs in
  it: one step reads the run's proposal (immutable between gate and
  publish — what was approved is what opens), refuses protected refs
  (hard deny list always; the checkout's origin/HEAD with the push),
  pushes the branch, opens the PR, and folds the url into the visit
  outcome and wake. ticket/bugfix reshaped: verify proposes, a
  `pr-approve` human gate decides, `publish` executes (reseed
  `--replace` at deploy).
- **The stage graph is policy, so `edit_machine` is approval-gated**
  like create_machine (it was the only ungated machine write — an
  agent could otherwise rewire a machine to skip its gates).

Known seam for the future: the harness SDK's `awaiting_tool_approval`
state is the designed path for native mid-turn harness approvals
(roadmap 3.5) — not hooks in steps.

## Why

The trial exposed that git write protection does not exist. `create_pr`
executes immediately with no gate, and every project sandbox carries the
full PAT in `/workspace/.git-credentials` (`installCredentialStore`) — so
`git push origin main` works from any sandbox bash, and pi/claude inherit
it. 0033's principle, applied honestly: inside a sandbox the boundary is
the **token's scopes**, not tool allowlists or prompt instructions.

## Decisions (Chad, this chat)

- **Every `create_pr` is approval-gated, always** — chats and machine
  stages. Never a silent PR. The gate kills the willy-nilly default;
  pushing branches stays ungated so the daily loop keeps its friction.
- **Branch rule: deny list** — never `main`/`master`/`develop` plus the
  repo's default branch. No prefix allowlist.
- **Sandbox credential becomes read-scoped; pushes are brokered.**
- **Threat model: accidents and lazy defaults, not a determined
  in-sandbox adversary.** Write-credential delivery is per-command env
  (the 2.2 pattern in miniature); the `/proc/<pid>/environ` race during
  a push is accepted and documented. Bundle-out (copy a git bundle from
  the sandbox, push from the app container) is the stricter fallback if
  the threat model ever changes.
- **Tool shape: separate tools per verb** (`git_push`, `create_pr`),
  host-neutral behind the GitHost seam — not one `git` tool with an op
  enum. Reasons: the tool description is where the model learns the
  boundary (a gated `create_pr` says so; an op enum buries it); the gate
  is visible per tool, not a runtime surprise; it matches the machine/
  project tool convention (0015: separate tools over shared cores); and
  union-typed inputs invite mis-parameterization. Bash stays the surface
  for every read/local git op — only the two privileged verbs are tools.

## The credential split

`git_credentials` gains a `purpose` column (`sandbox-read` |
`server-write`; existing rows default `server-write`). Seeded through
`scripts/seed.mjs` upserts like today's credentials:

- **sandbox-read** — GitHub fine-grained PAT `contents:read` scoped to
  the org/repos; Forgejo token scoped `read:repository`. The only
  credential `setupProjectWorkspace` ever installs. Clone/fetch/pull
  keep working; `git push` from bash fails at the host (403).
- **server-write** — a dedicated sweatshop-writer PAT (`contents:write`
  on the registered repos), not Chad's personal token. Used only by
  app-side code on the GitHost seam; never persisted into a sandbox.

Existing sandboxes keep their old full-token line until the next
provisioning pass rewrites it (`installAuth` dedups per credential);
acceptable window, called out at deploy.

## Tools

- **`git_push`** `{repo, branch, force?}` — checks the deny list
  app-side (hardcoded set ∪ the checkout's `origin/HEAD`), then runs
  `git push` inside the sandbox with the write credential injected
  per-command (`http.extraheader` through the exec env;
  `SandboxHandle.run` already takes env). `force` defaults false and is
  allowed only on unprotected refs. Not approval-gated: the deny list
  plus the read token bound it, and the daily verb must stay cheap.
- **`create_pr`** — unchanged core (`openProjectPR`), now suspends on
  the ask_chad hook exactly like `create_machine`: `pending_inputs`
  row, /inbox card, opens only on approve. Before asking, gather repo,
  head→base, title, commit list + diffstat from the sandbox so the card
  is decidable on its face. Machine stages get the same gated tool via
  the host-tool seam (`harness-step`).
- **`gh` / `forgejo`** (0033) stay as-is — read-only discovery — until
  phase D absorbs them.

## Enforcement stack (each layer assumes the previous failed)

1. `git_push` refuses protected refs.
2. Bypassed, bash pushes 403 on the read-scoped token.
3. Write token stolen anyway: host branch protection (Forgejo:
   chad/sweatshop, chad/skills — scripted via API; GitHub rulesets
   where Chad has admin) blocks protected-branch pushes.
4. Everything still lands as a PR Chad approves.

## Phases

- **A — Gate `create_pr`** *(done, in the shape above)*: chat hook
  gate; propose_pr + gate card + publish stage; edit_machine gated.
- **B — Credential split + `git_push`** — `purpose` migration, read
  tokens installed at provisioning, the tool + deny list, re-provision
  note. Tests: deny list, purpose resolution, value-shaped errors.
- **C — Host-side backstops** — Forgejo scripted from bee; GitHub
  rulesets where Chad has admin (his action, not the app's).
- **D — Absorb discovery reads** into host-neutral seam tools
  (`search_repos`, `view_repo`, `list_pulls`, `view_pull`, …), then
  delete the bespoke `gh`/`forgejo` pair. Credential-is-the-switch
  stays.
- **E — docs/agent/\* rewrite** for the new surface.

## Non-goals

Prefix allowlists; bundle-out delivery; approvals on push;
harness-specific paths (pi/claude get host tools and the same read
token — nothing special).
