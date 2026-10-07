#!/usr/bin/env bash
# Deploy sweatshop on bee (0020): the checkout this script lives in is the
# deploy checkout, and the `sweatshop` rootless user quadlet serves it.
#
#   scripts/deploy.sh           fast-forward to origin/main and deploy
#   scripts/deploy.sh <ref>     deploy a specific commit (rollback)
#
# Steps: refuse a dirty tree → resolve the target → snapshot the db
# (data/backups/pre-<sha>.db, newest 10 kept) → stop the service → move
# the checkout → npm ci + next build + db:migrate in a one-off container →
# start → wait for /api/attention. A failed build or migrate puts the
# previous commit back, rebuilds it, and starts it again; restore the
# pre-<sha> snapshot by hand only if a migration had already applied.
#
# A host script on purpose: sweatshop's own sandboxed agents cannot run
# it, so the app never redeploys itself.
set -euo pipefail

# The deploy moves the checkout this script lives in, and bash reads a
# script lazily as it runs — so a deploy that changed deploy.sh executed a
# mix of old and new lines (2026-10-07: the old build() ran, and the
# service went down). Re-exec from a private copy first, so the whole run
# is the version that started.
if [[ -z "${SWEATSHOP_DEPLOY_COPY:-}" ]]; then
  copy="$(mktemp "${TMPDIR:-/tmp}/sweatshop-deploy.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$copy"
  export SWEATSHOP_DEPLOY_COPY="$copy"
  export SWEATSHOP_DEPLOY_ROOT
  SWEATSHOP_DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  exec bash "$copy" "$@"
fi
trap 'rm -f "$SWEATSHOP_DEPLOY_COPY"' EXIT

ROOT="$SWEATSHOP_DEPLOY_ROOT"
cd "$ROOT"
UNIT=sweatshop
URL="${SWEATSHOP_URL:-http://localhost:3300}"

say() { printf '\033[1m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# Agent and SSH shells often lack the user-bus variables; the user
# manager is always up (crussell lingers), so point at it directly.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
user_systemctl() { systemctl --user "$@"; }

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  die "checkout has local changes — the deploy checkout only moves through this script"
fi

previous="$(git rev-parse HEAD)"
if [[ $# -ge 1 ]]; then
  git fetch --quiet origin
  target="$(git rev-parse --verify "$1^{commit}")"
else
  git fetch --quiet origin
  git merge-base --is-ancestor HEAD origin/main \
    || die "HEAD is not an ancestor of origin/main (diverged) — resolve by hand"
  target="$(git rev-parse origin/main)"
fi
short="$(git rev-parse --short "$target")"
say "deploying $short (from $(git rev-parse --short "$previous"))"

# npm ci runs with --ignore-scripts: npm synthesizes `node-gyp rebuild`
# for any package shipping a binding.gyp, and better-sqlite3 13 ships one
# beside its bundled prebuilds/*.node, so a plain `npm ci` tries to compile
# it — and the image has no python/g++ (the first deploy failed exactly so,
# 2026-10-07). Then rebuild only the packages whose install scripts fetch a
# platform binary. Keep this list in sync with `npm install-scripts ls`.
NATIVE_REBUILD="esbuild @swc/core unrs-resolver @mongodb-js/zstd cbor-extract protobufjs"

# `next build` can finish its work — summary printed, .next complete —
# and then never exit: on 2026-10-07 its turbopack workers kept it alive
# for 7+ minutes while the service sat stopped (not reproducible from a
# fresh checkout, so the cause is unknown). So the build is never trusted
# to exit: it runs under a hard ceiling, and once it prints the route
# legend (the last thing a successful build writes) it gets a short
# grace period, then its container is removed and the build is judged by
# its output. .next is cleared first — no stale state (it had grown to
# ~470 MB); a normal build is ~25 s.
BUILD_TIMEOUT="${BUILD_TIMEOUT:-600}"
BUILD_EXIT_GRACE=15
BUILD_DONE_MARK="server-rendered on demand"

next_build() {
  local log name="sweatshop-build-$$" started=$SECONDS done_at="" rc=0 pid
  log="$(mktemp "${TMPDIR:-/tmp}/sweatshop-build.XXXXXX")"
  say "next build (ceiling ${BUILD_TIMEOUT}s)"
  DEV_EXEC_NAME="$name" ./dev exec -- sh -c "rm -rf .next && exec npx next build" >"$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ -z "$done_at" ]] && grep -q "$BUILD_DONE_MARK" "$log"; then done_at=$SECONDS; fi
    if [[ -n "$done_at" ]] && (( SECONDS - done_at >= BUILD_EXIT_GRACE )); then
      say "build finished but did not exit within ${BUILD_EXIT_GRACE}s — removing its container"
      break
    fi
    if (( SECONDS - started >= BUILD_TIMEOUT )); then
      say "build exceeded ${BUILD_TIMEOUT}s — removing its container"
      break
    fi
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    podman rm -f "$name" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  else
    wait "$pid" || rc=$?
  fi
  tail -n 20 "$log"
  # Judged by output: no route legend (or a failing exit) = failed.
  grep -q "$BUILD_DONE_MARK" "$log" || rc=1
  rm -f "$log"
  (( rc == 0 )) && say "build ok in $((SECONDS - started))s"
  return "$rc"
}

build() {
  ./dev exec -- sh -lc "npm ci --no-audit --no-fund --ignore-scripts \
    && npm rebuild $NATIVE_REBUILD \
    && node -e 'new (require(\"better-sqlite3\"))(\":memory:\")'" \
    && next_build \
    && ./dev exec -- npm run db:migrate
}

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "$URL/api/attention"; then return 0; fi
    sleep 1
  done
  return 1
}

./dev exec -- env SNAPSHOT_KEEP=10 node scripts/db-snapshot.mjs "pre-$short"

say "stopping $UNIT"
user_systemctl stop "$UNIT" || true

if [[ $# -ge 1 && "$target" != "$(git rev-parse origin/main)" ]]; then
  git checkout --quiet --detach "$target"
else
  git checkout --quiet main && git merge --quiet --ff-only "$target"
fi
# NOTE: anything below runs from the private copy made at the top, so it
# is always the deploy.sh that started — even when this deploy changed it.

if ! build; then
  say "build or migrate failed — restoring $(git rev-parse --short "$previous")"
  git checkout --quiet --detach "$previous"
  build || die "rebuild of the previous commit failed too — the service is DOWN; fix the build, then: systemctl --user start $UNIT"
  user_systemctl start "$UNIT"
  wait_healthy || die "previous version did not come back healthy — the service is DOWN"
  die "deploy of $short failed; $(git rev-parse --short "$previous") is serving again (if a migration ran, restore data/backups/pre-$short.db)"
fi

say "starting $UNIT"
user_systemctl start "$UNIT"
wait_healthy || die "$UNIT did not answer $URL/api/attention within 60 s — check: journalctl --user -u $UNIT -n 50"
say "ok: $short is live at $URL"
