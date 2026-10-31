# 0091 — Image-era serving: CI-built zot images replace build-on-target

Status: **approved by Chad in chat, 2026-10-31 — this doc records the design.**

Supersedes the build-on-target halves of 0045 (deploy pipeline); the
drift-check / transient-unit / ntfy scaffolding retires in step 3.

## Why

The serving container is the last hand-tuned piece that treats a live
host checkout as build infra: the deploy stops the service, checks out
the target commit on bee, runs `npm ci` + `next build` in a one-off
container against a checkout bind, migrates, and restarts. Everything
hard about 0045's deploy — the `sweatshop-deploy` transient unit (an
agent once killed its own deploy through the exec seam), the flock, the
build-exit watchdog, the rollback-rebuild path — exists because the
build happens on the target, inside the stop→start window.

tastyquant already runs the target shape: CI builds the image, pushes
it to the bees zot registry (`10.10.0.6:5000`) as `<sha7>` (immutable
record) + `main` (what serves), and deploys are pull + restart. This
moves sweatshop to the same model. Not a PaaS-ification: the podman
socket bind and sibling-sandbox architecture stay exactly as they are.

## End state

- `Containerfile` (multi-stage): build stage runs `npm ci` + plain
  `next build` (webpack path — the 2026-10-07 `--turbopack` lesson),
  serve stage is the Containerfile.dev runtime deps (docker-cli, git,
  pinned gh) plus the built tree. Entrypoint runs `scripts/migrate.mjs`
  then `next start` — so an image is self-contained including its
  schema step.
- Forgejo `deploy.yml` grows an `image` job (merge to main only):
  build, tag `sweatshop/app:<sha7>` + `:main`, push to zot. PRs stay
  gated on GitHub (Forgejo is a pull mirror — no PR events); the image
  carries no in-image tests, so pre-merge image builds would only burn
  runner time.
- The cn quadlet (separate cn PR) swaps to `Image=10.10.0.6:5000/
  sweatshop/app:main` with the data dir bind-mounted from
  `~/.sweatshop-data` (one-time `mv ~/sweatshop/data ~/.sweatshop-data`),
  `.env.local` relocated beside it, and `AutoUpdate=registry` OFF —
  the deploy workflow owns when the service moves (pull + restart),
  with the nightly auto-update as catch-up only, matching tastyquant.
  Zot retention for `sweatshop/*` lands in the same cn PR.
- Deploy shrinks to: snapshot db (kept — the cheap belt), pull, restart,
  health check. `scripts/ci-deploy.sh` and the build-on-target path are
  deleted. Rollback = dispatch the workflow with an older sha (pull +
  restart); if a migration already ran, restore
  `~/.sweatshop-data/backups/pre-<sha>.db` per the runbook below.

## Steps (each independently shippable, always a working deploy path)

1. **This PR** — Containerfile + .dockerignore + the `image` job.
   Live serving is untouched (ci-deploy.sh still deploys); every merge
   to main additionally produces a zot image.
2. **cn PR** — quadlet swap + data move + zot retention. Cutover
   downtime ≈ the restart.
3. **sweatshop PR** — shrink the deploy job to pull+restart, delete
   ci-deploy.sh, update AGENTS.md.

## Known trades (accepted)

- Image ≈ 1.5–1.7 GB (tastyquant-class): `next start` needs full
  node_modules. A follow-up could adopt `output: "standalone"` (~300–500 MB)
  — interacts with `serverExternalPackages` (better-sqlite3 et al), so
  it is explicitly out of scope here.
- Rollback no longer auto-restores the pre-deploy db snapshot when a
  migration ran: an image rollback runs older code against a newer
  schema. Drizzle changes are additive in practice; the snapshot is
  still taken, and the restore is a documented `cp` instead of
  automatic.

## Runbook: restore after a bad migration

```
systemctl --user stop sweatshop
cp ~/.sweatshop-data/backups/pre-<sha>.db ~/.sweatshop-data/sweatshop.db
# (also remove sweatshop.db-wal / -shm if present)
podman pull --tls-verify=false 10.10.0.6:5000/sweatshop/app:<older-sha7>
systemctl --user start sweatshop
```
