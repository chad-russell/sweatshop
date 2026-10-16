# 0045 — Forgejo Actions deploy pipeline (deploy.sh retired)

Status: **approved 2026-10-16 (Chad, in chat); implementation on
`glen/forgejo-actions-deploy`.** Supersedes docs/0020 §"Out of scope:
Automatic deploy on merge (deploys stay deliberate)" and rewrites its
§"Deploying".

## Goal

Merge to `main` ships. The deploy path is a Forgejo Actions workflow in
this repo: PRs get the gate (typecheck / lint / test) as CI checks, a
merge to `main` deploys automatically, and rollback is a
`workflow_dispatch` run with a sha input. `scripts/deploy.sh` is
deleted. The workflow becomes the primary, documented way deploys
happen; dsh stays the emergency path.

## Why now

- **2026-10-16 incident**: sweatshop's own chat agent ran
  `scripts/deploy.sh` on bee through the 0043 exec host channel. The
  deploy's `systemctl --user stop sweatshop` killed the app driving the
  SSH channel; sshd tore the session down and the deploy died mid-build
  (checkout fast-forwarded, no build, service down, no restore branch).
  It then retried the same way and self-killed again. A deploy whose
  first step kills its own caller must never be launched by the app.
  0020's "host script so the app can't redeploy itself" stopped being
  true the day the exec seam landed.
- **The deliberateness is friction, not safety**: six deploys in ~20 h
  (2026-10-15 → 16), each hand-run after a merge Chad already reviewed.
  The PR merge IS the deliberate act.
- **The household pattern exists**: cn's `.forgejo/workflows/deploy.yml`
  auto-deploys on merge via the bees `nix-host` runner (job shells as
  crussell — SSH keys + sudo), queues instead of cancelling concurrent
  runs, uses `workflow_dispatch` as the retry path (this Forgejo build
  has no re-run API), pings ntfy on failure, and runs self-endangering
  activation detached via `systemd-run` because activating bees can
  restart the runner mid-job.

## Findings

- sweatshop has **no `.forgejo/` at all** — no CI on PRs either. The
  quality gate runs only when the PR author ran it in a sandbox;
  "merge → auto-deploy" without CI would ship unverified code. The
  checks job is load-bearing, not decoration.
- `./dev` hardcodes the `sweatshop-node-modules` volume **shared with
  the live service** and the rootless user socket. It is the right tool
  for the deploy body on bee (service stopped, same volumes as today)
  and the wrong tool for CI checks on a runner (a CI `npm ci` would
  clobber the live app's dependencies; a second checkout on bee would
  race the deploy checkout). Checks get their own container invocation
  on bees with throwaway volumes.
- **The deploy must outlive its caller.** If the runner, bees, or the
  SSH channel dies during the stop→build→start window, the service
  stays down — the exact hole from the incident. The mid-build window
  needs an owner no channel death can reach: a transient user unit on
  bee (`systemd-run --machine=crussell@.host --user`, fixed unit name),
  the mechanism used to recover 2026-10-16 and by cn for its bees
  self-switch.
- bees `nix-host` runner: jobs execute as crussell with `~/.ssh`,
  gitconfig, sudo, podman (rootless) — verified in
  `hosts/bees/forgejo-runner.nix`. bees→bee SSH as crussell is a
  proven path (cn's drift checks use it every deploy).
- On bee, `/run/wrappers/bin/sudo` is the setuid wrapper (bare `sudo`
  in non-interactive shells resolves to the store binary and fails);
  crussell is wheel with passwordless sudo, so the runner can create
  the machine-scoped transient unit without root SSH.

## Design

### 1. `.forgejo/workflows/deploy.yml`

```yaml
on:
  pull_request:            # checks only — never deploys
  push:
    branches: [main]       # checks + deploy
  workflow_dispatch:       # retry / rollback: inputs.sha (default: origin/main)
concurrency:
  group: sweatshop-deploy
  cancel-in-progress: false   # queue, never cancel mid-deploy
```

- **checks job** (`runs-on: nix-host`, bees): checkout via
  `GITHUB_TOKEN` (cn pattern) → `podman build` `Containerfile.dev` →
  `podman run` with an anonymous `node_modules` volume and a persistent
  `sweatshop-ci-npm-cache` volume:
  `npm ci --ignore-scripts` + the native-rebuild list +
  `npm run typecheck && npm run lint && npm run test`.
  No `.env.local` — the gate runs against per-worker temp databases and
  mock models by construction (AGENTS.md rule); if a check ever needs a
  key it becomes a Forgejo secret then.
- **deploy job** (`needs: [checks]`; runs on push-to-main and dispatch
  only): resolve target sha → `ssh bee` as crussell → **drift check**:
  read the deploy checkout's `HEAD` on bee; if it already equals the
  target and `/api/attention` answers, the run is a no-op (cn's
  build-diff analog) → else create the transient unit and poll:
  `ssh bee '/run/wrappers/bin/sudo systemd-run --machine=crussell@.host
  --user --collect --wait --unit=sweatshop-deploy
  /run/current-system/sw/bin/bash ~/ss/sweatshop/scripts/ci-deploy.sh <sha>'`
  then verify `/api/attention` 200.
- **Notify**: ntfy (bees `:8090`) topic `sweatshop-ci` — urgent ping on
  failure with a link to the run; quiet or low-priority note on
  success/no-op (cn's `cn-ci` pattern).

### 2. `scripts/ci-deploy.sh` — the deploy body

Runs **only inside the `sweatshop-deploy` transient unit**: it refuses
to start unless the unit's marker env var is set, so an interactive or
exec-channel invocation fails fast — the 2026-10-16 class is closed
structurally, not by convention. It inherits every invariant from
`scripts/deploy.sh`, minus the trigger logic the workflow now owns:

1. Re-exec from a private copy (the lazy-read hazard deploy.sh hit on
   2026-10-07 — a deploy that changed the script must run the version
   that started).
2. Refuse a dirty tree; `git fetch origin`; checkout the target sha
   (detached for rollbacks, `main` + ff-only for merges).
3. Snapshot the DB (`pre-<sha>.db`, keep 10).
4. `systemctl --user stop sweatshop`.
5. `./dev exec` as today: `npm ci --ignore-scripts` + native rebuilds +
   `better-sqlite3` smoke, `next build` under the ceiling/grace/
   route-legend judging, `npm run db:migrate`.
6. `systemctl --user start sweatshop`; poll `/api/attention` ≤ 60 s.
7. On build/migrate failure: restore the previous commit, rebuild,
   start it, exit non-zero (workflow pings ntfy).
8. Fixed unit name + `flock` on a lock file: two deploy attempts
   serialize; the second systemd-run fails loudly while one runs.

### 3. Removals and rewrites

- `scripts/deploy.sh` deleted (its logic lives in ci-deploy.sh; the
  manual-trigger model dies).
- `./dev` header comment: deploy references → the workflow.
- AGENTS.md "Environment" rewritten: the deploy checkout moves only
  through the deploy workflow; rollback = Actions UI dispatch with a
  sha; dsh emergency path = create the transient unit by hand (exact
  command documented); "host script on purpose" paragraph replaced with
  the exec-seam lesson.
- docs/0020: status line gains a supersession pointer to 0045.

### 4. Auth and secrets

None new. Checkout uses the job's `GITHUB_TOKEN`; bees→bee SSH uses
crussell's existing keys; the on-bee `git fetch` keeps using the deploy
checkout's `core.sshCommand` glen key; sudo via bee's wrapper path.

## Phases

1. This doc approved.
2. Branch (a worktree beside the deploy checkout — the deploy checkout
   itself stays on clean `main`): workflow + `ci-deploy.sh` + AGENTS.md
   + deletions; gate green in a container.
3. PR → the pull_request checks run for real (first live exercise of
   the checks half).
4. Deploy-half test: if this Forgejo supports dispatch from a branch
   ref, dispatch the branch sha — a real, watched deploy of exactly the
   PR's code; otherwise go straight to merge-day with the rollback
   dispatch armed.
5. Merge → the push-triggered run deploys (or no-ops on drift if phase
   4 already shipped that sha); watched to green, ntfy verified.
6. Optional drill, Chad's call: dispatch a rollback to the prior sha
   and back, proving the rollback path end-to-end.

## Out of scope

- Staging/preview deploys, zero-downtime, blue-green.
- Any change to the 0043 exec seam itself (bee on the sweatshop
  project's host list) — separate question raised by the incident.
- Nightly/scheduled workflows.
