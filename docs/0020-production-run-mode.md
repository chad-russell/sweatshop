# 0020 — Production run mode and backups

Status: **approved 2026-10-07 (Chad); phases 1–3 shipped 2026-10-07, phase 4 (first nightly restic check) pending.** Phase 0 of `docs/ROADMAP.md`. §"Deploying" superseded by 0045 (Forgejo Actions pipeline) 2026-10-16.

## Goal

Sweatshop runs as one ordinary service on bee: production build,
restarts on crash and boot, state in the nightly backups. There is no
separate dev instance. Sweatshop develops itself like any other project
— a sandboxed chat or machine run opens a PR against its Forgejo repo —
and a merged change ships by redeploying the service. dsh remains the
emergency path if a deploy breaks the app.

## Findings (2026-10-07)

- **The app runs only as `./dev`**: `podman run --rm` of the dev image,
  attached, `next dev`. Nothing restarts it after a reboot.
- **Nothing of sweatshop is backed up.** bee's restic paths
  (`hosts/bee/backup.nix` in cn) do not include `~/ss`; the only copies
  of `data/sweatshop.db` are hand-made `.bak` files beside it.
- **Workflow state lives in `.next/workflow-data`** (124 MB: runs,
  events, hooks, steps, streams). `withWorkflow()` defaults
  `WORKFLOW_LOCAL_DATA_DIR` there when unset, so `rm -rf .next`, a common
  fix for a broken build, deletes every in-flight run, suspended gate and
  pending `ask_chad`.
- **Hot-reload hazard, observed**: the dev server's sandbox reaper had
  failed every pass (80) since migration 0032 renamed a column. `next dev`
  reloaded routes, but the long-lived timer kept the old module. A
  restart fixed it. In production, a migration always pairs with a
  restart, so this class goes away.
- **A production build works today.** Verified 2026-10-07 on a copy of
  the live DB: `next build` succeeds (all routes dynamic); `next start`
  serves `/`, `/inbox`, `/machines`, `/machines/ticket`, `/sandboxes`,
  `/r/<id>`, `/api/attention` (all 200, ~30–40 ms warm, first request
  554 ms); and a `think` run went draft → critique → parked at the
  `decide` human gate in 18 s. So workflows, agent stages, sandbox
  provisioning and hooks all work under `next start`.
- **Build directory constraint**: Next rewrites `tsconfig.json` whenever
  it builds into a new `distDir`, so the build always uses the one
  default `.next`. Building while the server runs from that same
  directory is unsafe (lazy chunk loads), hence the stop-build-start
  deploy below.
- Housekeeping done in Phase 0: `smoke` machine deleted; test executor
  bundle leak fixed (a73f8e3, 1.2 GB removed); 33/33 migrations applied,
  no schema drift; the 3 bad runs are all from 2026-10-01, before
  `bcb73df` fixed the bootstrap `mkdir`; every run since has completed.
- Noticed for the catalog item: the live `think` machine (version 4) has
  `workspace: "project"`, so it refuses to run without a project, but
  its seed says `none`. Fix it with the catalog rework (roadmap 1.6).

## Design

### 1. One checkout, one data directory

`~/ss/sweatshop` stays the only checkout. After go-live it is the
**deploy checkout**: it tracks `main` on the Forgejo remote and changes
only through `scripts/deploy.sh`. Work on sweatshop happens in sandboxes
(like any project) and arrives as merged PRs.

All state stays under the existing gitignored `data/`:

- `data/sweatshop.db` (+ `-wal`, `-shm`), unchanged.
- `data/workflow-data/`, set explicitly by `WORKFLOW_LOCAL_DATA_DIR` (with
  `WORKFLOW_TARGET_WORLD=local`) so it moves out of `.next/`. One-time move of the current
  `.next/workflow-data/` while the server is stopped.
- `data/backups/`, the pre-deploy and nightly snapshots.

Backups then need exactly one new path.

### 2. Forgejo remote

Done 2026-10-07: the existing private `chad/sweatshop` (the prototype's
remote) now holds this repo on `main` (force-replaced at Chad's direction);
the prototype's full history, including 25 commits that had never been
pushed, is kept as `archive/prototype` plus its `v0.*` tags, and its 16
old feature branches were deleted. A local bundle of the prototype is at
`/tmp/sweatshop-prototype-2026-10-06.bundle` until the next reboot. Register sweatshop as a project inside sweatshop with that
repo, so `create_pr` targets it. Done during cut-over via the existing
Forgejo token path (forgejo-pr skill).

### 3. The service

A rootless user quadlet in cn, `hosts/bee/sweatshop.nix` +
`hosts/bee/sweatshop/sweatshop.container`, using hindsight's mechanics
(materialize under `/etc`, symlink into `~/.config/containers/systemd`,
daemon-reload, enable):

- Image `localhost/sweatshop-dev` (node 24 + docker-cli + git, as today;
  the name stays to avoid churn).
- `Exec=sh -lc 'exec npx next start -p 3000'`, `WorkingDir=/workspace`.
- Mounts: the checkout at `/workspace`, the existing
  `sweatshop-node-modules` volume at `/workspace/node_modules`, the host
  podman socket at `/var/run/docker.sock`. `EnvironmentFile=` the
  checkout's `.env.local`.
- `Network=sweatshop-harness`, declared by a `sweatshop-harness.network`
  quadlet (same name, so existing sandboxes stay attached; `./dev` keeps
  its create-if-missing).
- `PublishPort=3300:3000` and `PublishPort=10.10.0.12:3301:3001`
  (unchanged URLs; bees' Caddy preview route needs no change).
- `Environment=NODE_ENV=production WORKFLOW_TARGET_WORLD=local
  WORKFLOW_LOCAL_DATA_DIR=/workspace/data/workflow-data`. Both are
  required: `withWorkflow()` overwrites the data dir to
  `.next/workflow-data` whenever `WORKFLOW_TARGET_WORLD` is unset (found
  when the 2026-10-07 trial's run landed in the live dir despite the
  variable; its 359 files were removed).
- `Restart=always`, `[Install] WantedBy=default.target` (crussell lingers,
  so it starts at boot).

`./dev` stays as the tool for `./dev exec -- …` (tests, migrations, the
gate) and `./dev shell`. Its `run` mode is removed, since the service is
the only server.

### 4. Deploying

`scripts/deploy.sh` on bee, run by Chad (or an agent in dsh). It is a
host script, so sweatshop's own sandboxed agents cannot redeploy it:

1. `git fetch origin && git merge --ff-only origin/main` (refuse if the
   checkout has local changes or diverged).
2. Snapshot the DB to `data/backups/pre-<sha>.db` (better-sqlite3's
   `backup()`, the same call verified in the trial; keep the last 10).
3. `systemctl --user stop sweatshop`.
4. `npm ci` + `next build` + `npm run db:migrate` in a one-off container
   (`./dev exec`). On failure: `git reset --hard <previous sha>`, rebuild,
   start the old version, exit non-zero.
5. `systemctl --user start sweatshop`; poll `/api/attention` for 200 up to
   60 s.

Downtime is the install + build, a few minutes. That's acceptable for a
single user. In-flight workflow runs resume on start (the local world
re-enqueues active runs by default), and suspended gates and hooks are
files in `data/workflow-data/`, so they survive. A step interrupted
mid-flight is retried, as on any restart.

Rollback: `scripts/deploy.sh <sha>` deploys an older commit; if the
bad deploy ran a migration, restore `data/backups/pre-<sha>.db` with the
service stopped. That's the whole recovery path dsh would follow.

### 5. Backups

- cn `hosts/bee/backup.nix`: add `/home/crussell/ss/sweatshop/data`.
  restic captures db + WAL together, which SQLite recovers cleanly
  (the bees wankbank comment records what happens with a bare `.db`).
- A user timer an hour before the restic window writes
  `data/backups/nightly.db` with `VACUUM INTO`, so restic always holds one
  guaranteed-consistent copy.
- The `.bak` and `pre-0007`/`pre-0009` files in `data/` move into
  `data/backups/` (or get deleted, Chad's call).

## Phases

1. **Repo**: `WORKFLOW_LOCAL_DATA_DIR` documented in `.env.example`,
   `scripts/deploy.sh`, `scripts/db-snapshot.mjs` (shared by deploy and
   the nightly timer), `./dev` loses `run`, AGENTS.md "Environment"
   rewritten for the service. Gate green; commit.
2. **cn**: `hosts/bee/sweatshop.nix` + container + network units +
   snapshot timer; backup path; deploy bee (dsh-web bounce caveat from
   homelab-ops).
3. **Cut-over**: create the Forgejo repo, push, add `origin`; stop
   `./dev`; move `.next/workflow-data` → `data/workflow-data`; first
   `scripts/deploy.sh`; verify `/inbox`, sidebar history, a chat turn, a
   preview URL through bees, the reaper's first pass in the journal;
   register sweatshop as a project.
4. **Backup check**: after the next nightly run, `restic ls latest`
   shows `data/`.

## Out of scope

- A dev instance, a second checkout, staging, zero-downtime deploys.
- Automatic deploy on merge (deploys stay deliberate).
- A separate production image.
- Auth: still LAN/Nebula only (hard rule unchanged).

## Shipped (2026-10-07)

- Phase 1: ac56c21. Phase 2: cn PR #67 (merged; bee's deploy started the
  unit at once, serving the build already in `.next`, because quadlet's
  `[Install]` wiring starts a newly generated unit on daemon-reload).
- Cut-over: the first `scripts/deploy.sh` took the service DOWN for
  ~2 min — `npm ci` wiped node_modules, then npm's synthesized
  `node-gyp rebuild` for better-sqlite3 (it ships a `binding.gyp` beside its
  bundled prebuilds) failed on an image with no python/g++, and the
  rollback rebuild failed identically. Restored by hand with
  `npm ci --ignore-scripts` + targeted `npm rebuild`; the script now does
  exactly that (PR #27), and the unused eve-era `just-bash` (pulling the
  prebuild-less `node-liblzma`) is gone.
- Verified on the live service: pages and `/api/attention` 200; a `think`
  run went draft → critique → parked at `decide`, its state written to
  `data/workflow-data/`; the service was restarted while parked and the
  gate answered afterwards completed the run (gates survive restarts);
  the run and its sandbox were then purged. The nightly snapshot unit
  ran once by hand (`data/backups/nightly.db`); the preview proxy answers
  on 10.10.0.12:3301; the reaper started clean.
- Cosmetic: `npx` logs `npm error signal SIGTERM` on every stop. Harmless;
  swap the entrypoint to `node node_modules/next/dist/bin/next` if it
  becomes noise.
