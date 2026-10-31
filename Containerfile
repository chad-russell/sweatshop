# sweatshop serving image — the CI-built image-era artifact (0091).
#
# Shape: multi-stage; the serve stage is Containerfile.dev's runtime
# (docker-cli for the sandbox provider's sibling containers on host
# rootless podman, git for ls-remote + agent shells, pinned gh for the
# github discovery tool) plus the built tree. The build stage carries
# the toolchain once and only the final image ships.
#
# Deploy model: Forgejo deploy.yml builds this on merge to main and
# pushes to the bees zot registry as sweatshop/app:<sha7> + :main;
# the cn quadlet runs :main (deploy = pull + restart). Replaces
# build-on-target (ci-deploy.sh, 0045) — see docs/0091 for the design.
#
# Build: next build runs WITHOUT --turbopack (webpack path) on purpose:
# the deploy path's 2026-10-07 lesson — turbopack workers can keep the
# build process alive long after .next is complete (route legend printed,
# then never exits; needed a container-kill watchdog). CI must not
# inherit a hang-class failure mode.
FROM docker.io/library/node:24-trixie-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts + targeted rebuild: npm synthesizes node-gyp rebuilds
# for anything shipping binding.gyp (better-sqlite3 ships one beside its
# prebuilds); the image has python/make/g++, but the targeted rebuild
# list is the proven path (2026-10-07; keep in sync with ci-deploy.sh
# and the checks job) and avoids rebuilding the world.
RUN npm ci --no-audit --no-fund --ignore-scripts \
  && npm rebuild esbuild @swc/core unrs-resolver @mongodb-js/zstd cbor-extract protobufjs

COPY . .
RUN npx next build

FROM docker.io/library/node:24-trixie-slim

# Runtime deps — mirrors Containerfile.dev's runtime set (comments there).
# docker-cli: the sandbox provider shells out to docker; the daemon is
# NOT here — the quadlet bind-mounts the host rootless podman socket.
# git: ls-remote (branch picker) + agent shells. gh pinned exactly
# (Debian carries no gh package): the github discovery tool runs the
# real CLI in this container.
ARG GH_VERSION=2.103.3
RUN apt-get update \
  && apt-get install -y --no-install-recommends docker-cli git ca-certificates curl \
  && ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.deb" \
       -o /tmp/gh.deb \
  && apt-get install -y --no-install-recommends /tmp/gh.deb \
  && rm /tmp/gh.deb \
  && rm -rf /var/lib/apt/lists/*

# better-sqlite3 compiled from source where no prebuilt exists (arm64
# dev machines) — the runtime needs the toolchain for npm rebuild if a
# sandbox ever installs deps. Keep parity with Containerfile.dev.
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/drizzle ./drizzle
# scripts/migrate.mjs runs at container start (the image is
# self-contained incl. its schema step); scripts/ also serves one-off
# ops (db-snapshot, sandbox-gc) inside the serving container.
COPY --from=build /app/scripts ./scripts
COPY package.json package-lock.json next.config.ts ./
COPY vendor/ ./vendor/
COPY public/ ./public/

# data lives OUTSIDE the image: the cn quadlet bind-mounts
# ~/.sweatshop-data at /app/data (never baked in).
ENV NODE_ENV=production
CMD ["sh", "-c", "node scripts/migrate.mjs && npx next start -p 3000"]
