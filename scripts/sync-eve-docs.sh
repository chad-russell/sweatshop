#!/usr/bin/env bash
# Sync the vendored eve docs from the installed package (inside the
# node_modules volume) into vendor/eve/docs, stamped with the version.
# Run after any eve version change: npm run docs:eve
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=docker.io/library/node:24-trixie-slim
MODULES_VOLUME=sweatshop-node-modules

mkdir -p "$ROOT/vendor/eve"

# One-off container with the same node_modules volume; copy the docs out
# through an extra bind so this works whether or not the dev container is
# running. No host node_modules required.
podman run --rm \
  -v "$ROOT":/workspace \
  -v "$MODULES_VOLUME":/workspace/node_modules \
  -v "$ROOT/vendor/eve":/out \
  -w /workspace \
  "$IMAGE" sh -c '
    set -eu
    rm -rf /out/docs
    cp -r /workspace/node_modules/eve/docs /out/docs
    node -e "console.log(require(\"/workspace/node_modules/eve/package.json\").version)" > /out/docs/VERSION
  '

echo "vendored eve docs ($(cat "$ROOT/vendor/eve/docs/VERSION")) → vendor/eve/docs/"
