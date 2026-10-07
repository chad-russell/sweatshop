# 0020 — Production run mode and backups

Status: **draft — awaiting Chad's approval.** Phase 0 of `docs/ROADMAP.md`.

## Goal

Sweatshop becomes a daily tool: it survives reboots and crashes without
a terminal, serves a production build, and its state is in bee's
nightly restic backups. Developing sweatshop stays on `./dev`, isolated
from the instance Chad works in.

## Findings (2026-10-07)

- **The app runs only as `./dev`**: `podman run --rm` of the dev image,
  attached, `next dev`, up since 2026-10-04 by luck. Nothing restarts it
  after a reboot.
- **Nothing of sweatshop is backed up.** bee's restic paths
  (`hosts/bee/backup.nix`) cover `~/Gloo`, `/var/lib/dsh`,
  `~/.local/share/containers` (volumes), and more — not `~/ss`. The only
  copies of `data/sweatshop.db` are hand-made `.bak` files beside it.
- **Workflow state lives in `.next/workflow-data`** (124 MB: runs,
  events, hooks, steps, streams), not `.workflow-data/`: `withWorkflow()`
  sets `WORKFLOW_LOCAL_DATA_DIR=.next/workflow-data` when unset. It sits
  inside the build directory next to 5 GB of disposable dev cache, so
  any `rm -rf .next` (a routine fix for a broken dev build) silently
  destroys every in-flight run and hook. A suspended human gate or an
  `ask_chad` would be lost.
- **One dev process is the whole product.** The reaper, preview proxy
  (:3001), and 30 s follower tick all start from `instrumentation-node.ts`.
- **A hot-reload hazard, observed tonight**: the dev server's reaper
  had failed every pass (80 times) since migration 0032 renamed
  `services_provisioned_at`. `next dev` reloaded routes with the new
  schema, but the long-lived reaper timer kept the module from before the
  migration. A restart fixed it. In production, a migration always pairs
  with a restart, so this class goes away.
- **`next build` succeeds today** (all routes dynamic). It writes into
  the same `.next/` the running dev server uses, so prod and dev cannot
  share a checkout without separating build directories.
- Housekeeping done in this phase: `smoke` machine deleted (runs keep
  their snapshots); the test executor no longer leaks an 8 MB bundle per
  run into `.workflow-data/` (1.2 GB removed, a73f8e3); migrations: 33
  journal entries / 33 applied, `drizzle-kit generate` reports no drift.
  The two `failed` and one `needs-attention` runs are all from
  2026-10-01, the `spike` project, before `bcb73df` fixed the bootstrap
  `mkdir` cwd; every run since has completed. No action.

## Design

### 1. Two instances, two checkouts

| | **prod** (daily use) | **dev** (working on sweatshop) |
|---|---|---|
| Checkout | `~/ss/sweatshop-prod` — a `git worktree` of this repo, pinned to a deployed commit | `~/ss/sweatshop` (unchanged) |
| Process | `next start` from a production build | `next dev` via `./dev` |
| Port | **3300** (the URL Chad already uses) | **3310** (`SWEATSHOP_PORT` default changes) |
| Preview proxy | `10.10.0.12:3301` (unchanged, bees' Caddy already points here) | off by default (`PREVIEW_PROXY_PORT=off`) |
| Reaper / tick | on | off by default (`SANDBOX_REAPER=off`, `PREVIEW_TICK=off`) |
| Data | `/home/crussell/.local/share/sweatshop/` | `./data/` (unchanged; a dev copy) |

Why a worktree and not the same tree: a production build must not be
replaced by whatever the dev checkout is mid-edit on, and the two
`.next/` directories must never collide. A worktree shares git objects
(no second clone), and "deploy" is an explicit act: move the worktree to
a commit, build, restart.

Why dev turns background work off: two reapers over two databases are
harmless, but two preview proxies cannot both bind :3001, and a dev
reaper over a copy of prod data would stop and destroy real sandboxes
that the copied rows point at (the containers are shared on host
podman). Dev can opt back in per variable.

### 2. State outside the checkout

One directory, `~/.local/share/sweatshop/`, holds everything that must
survive a rebuild:

- `sweatshop.db` (+ `-wal`, `-shm`) via `SWEATSHOP_DB`
- `workflow-data/` via an explicit `WORKFLOW_LOCAL_DATA_DIR` (setting it
  stops `withWorkflow()` from defaulting into `.next/`)

It sits under `~/.local/share`, so it is outside the checkout and the
`.next` blast radius. The existing restic path list doesn't cover it, so
cn adds it.

**Moving the data across** (one time): stop dev, copy
`data/sweatshop.db` (after `PRAGMA wal_checkpoint(TRUNCATE)`) and
`.next/workflow-data/` into the new directory, start prod. Dev then keeps
`./data` as a disposable copy. Runs that were in flight at the cut-over
resume in prod because the workflow world is copied too. Expect to check
any run that was live (there are none now).

### 3. The service

A rootless user quadlet in cn, `hosts/bee/sweatshop.nix` +
`hosts/bee/sweatshop/sweatshop.container`, using the same mechanics as
hindsight (materialize under `/etc`, symlink into
`~/.config/containers/systemd`, daemon-reload, enable):

- Image `localhost/sweatshop-dev` (node 24 + docker-cli + git, same as
  dev, so sandboxes and `git ls-remote` keep working). No separate prod
  image: the build output is in the worktree, and one image avoids drift.
- `Exec=sh -lc 'exec npx next start -p 3000'` with `WorkingDir=/workspace`.
  `node_modules` comes from its own named volume, `sweatshop-prod-node-modules`,
  so a dev `npm install` never changes prod's dependencies under it.
- Mounts: the prod worktree at `/workspace`, the data directory, the host
  podman socket at `/var/run/docker.sock`, `.env.local` from the prod
  worktree via `EnvironmentFile=`.
- `Network=sweatshop-harness` (claude bridge membership, 0006). The
  network is created by `./dev` today, so the quadlet adds a
  `sweatshop-harness.network` unit (same name, so existing sandboxes
  stay on it).
- `PublishPort=3300:3000` and `PublishPort=10.10.0.12:3301:3001`.
- `Restart=always`, `[Install] WantedBy=default.target` (crussell lingers,
  so it starts at boot).
- `Environment=NODE_ENV=production SWEATSHOP_DB=/data/sweatshop.db
  WORKFLOW_LOCAL_DATA_DIR=/data/workflow-data`.

Secrets stay in the worktree's `.env.local` (gitignored, mode 0600).
Moving them to agenix is possible but would split config across two
repos; the Secrets entity (roadmap 2.2) is the long-term home.

### 4. Deploying a new version

`scripts/deploy-prod.sh` in this repo, run from the dev checkout:

1. Refuse if the dev tree is dirty or the gate is not green (runs
   typecheck/lint/test in the container).
2. `git -C ~/ss/sweatshop-prod checkout --detach <commit>` (default `main`).
3. `npm ci` + `next build` inside a one-off container on the prod mounts.
   Build failure → stop here, prod keeps running the old build.
4. Snapshot the DB (`sqlite3 .backup` via node into
   `~/.local/share/sweatshop/backups/pre-<commit>.db`, keep the last 5).
5. `npm run db:migrate` against the prod DB.
6. `systemctl --user restart sweatshop`, then poll `/api/attention` until
   200 (fail loudly after 60 s).

Migrations run with the old server still up for a few seconds. Today's
migrations are additive or renames that the old server would fail on
until the restart; the window is seconds and the server is single-user,
so accept it rather than stopping first. Rollback = deploy the previous
commit plus restore the pre-deploy snapshot if a migration was involved.
This answers the roadmap's "releases and migrations" open question.

### 5. Backups

- cn `hosts/bee/backup.nix`: add `/home/crussell/.local/share/sweatshop`.
  restic captures db + wal together, which SQLite recovers cleanly; the
  bees wankbank note records the lesson of backing up a bare `.db`.
- For a consistent copy regardless of timing, a user timer runs
  `VACUUM INTO backups/nightly.db` an hour before the restic window.
  restic then always has one point-in-time copy even if the live pair
  was mid-write.
- `workflow-data/` is files, backed up as is. A torn file there would
  affect one run, not the database.

## Phases

1. **Repo side** (this repo): `SWEATSHOP_PORT` default 3310 and dev
   background work off by default in `./dev`; `scripts/deploy-prod.sh`;
   `scripts/db-snapshot.mjs` (the `VACUUM INTO` helper shared by deploy
   and the timer); AGENTS.md Environment section updated. Gate green.
2. **cn side**: `hosts/bee/sweatshop.nix` + quadlet + network unit +
   snapshot timer; backup path. Deploy bee (`dsh-web` bounce caveat from
   the homelab-ops skill: bee self-deploys restart dsh-web).
3. **Cut-over**: create the worktree, copy `.env.local`, first deploy
   via the script, stop dev, move the data, start prod, verify:
   `/inbox` loads, the sidebar shows existing chats, a preview URL
   resolves through bees, the reaper logs its first pass, and a chat
   turn works. Then start dev on 3310 against `./data`.
4. **Verify the backup**: after the next nightly run, `restic ls latest`
   shows the data directory.

## Out of scope

- A separate production image or multi-stage build.
- Zero-downtime deploys.
- Running prod on bees or anywhere but bee.
- Auth: still LAN/Nebula only (hard rule unchanged).

## Questions for Chad

1. Prod keeps **3300** and dev moves to **3310**? (Keeps your bookmarks;
   the alternative is prod on a new port.)
2. Data under `~/.local/share/sweatshop` OK, or would you rather it live
   somewhere else (e.g. `/srv`)?
3. Deploys by `scripts/deploy-prod.sh` that you (or I) run, rather than
   automatic on every commit to `main`? Automatic would deploy half-done
   work, since everything is on `main`.
