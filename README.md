# <img src="./app/icon.svg" alt="" width="28" height="28"> sweatshop

A personal software factory: a single Next.js app whose agent runtime is
the Vercel AI SDK (`WorkflowAgent`) on the Workflow SDK. You talk to an
agent; the agent works in sandboxed containers per conversation — cloning
your repos, running harnesses (pi, claude, cursor, codex), serving live
previews, and opening PRs you approve.

Single-user by design. `AGENTS.md` is the full architecture contract;
`docs/` holds the numbered design history. This file is how to run it
when it isn't already yours.

## Requirements

- Linux or macOS host with a Docker-compatible container engine:
  podman, OrbStack, Docker Desktop, or colima. The app shells out to the
  engine's `docker`/`podman` CLI; sandboxes run as sibling containers.
- Node 24 (for `./dev`'s helper commands and any host-side tooling).

## Where it runs

One hard rule: **the app container and the sandboxes must share one
container engine.** Sandboxes are reached over a private container
network (`sweatshop-harness`); the harness bridges (claude / cursor /
codex) and the preview proxy dial sandbox IPs there — membership in that
network is the boundary, so split-engine setups cannot work.

Two supported topologies:

1. **All-local** (a laptop): everything in your local engine via `./dev`.
   Sandboxes and the app sit on the same `sweatshop-harness` network;
   previews land on `pv-<slug>.previews.localhost` (browsers resolve
   `*.localhost` to 127.0.0.1) with no wildcard certificate needed.
2. **All-on-one-box** (a home-server / VM): the app runs as a systemd
   unit (or compose) on the machine, browser reaches it over LAN or
   Tailscale. Previews need `PREVIEW_BASE_DOMAIN` — a real domain with
   wildcard DNS pointing at the box (plus a cert) — or an SSH tunnel of
   the proxy port to your laptop.

Not supported: app on the laptop, sandboxes on a remote daemon. The app
dials sandbox container IPs, which are only routable inside the same
engine's network — `DOCKER_HOST` does not change that.

## Quickstart

```sh
cp .env.example .env.local                      # set at least one key FIRST
./dev install                                   # deps, inside the engine
./dev exec -- npm run db:migrate
DEV_PUBLISH=3000:3000 ./dev exec -- npm run dev # or: build && start
```

`./dev` runs everything inside the dev container with the repo
bind-mounted; `.env.local` is passed through. The wrapper publishes
nothing by default — in the all-local mode set `DEV_PUBLISH` (a comma
list of host:container pairs) so your browser can reach the app, e.g.
`DEV_PUBLISH=3000:3000,80:3001` also fronts the preview proxy on port
80 for the `pv-<slug>.previews.localhost` URLs. Point your browser at
http://localhost:3000. Set `SWEATSHOP_DB` to move the
sqlite database (default `./data/sweatshop.db`).

Production builds (`./dev exec -- npm run build`) use the project-local
TypeScript 7 native Go compiler for type checking, explicitly selected by
`experimental.useTypeScriptCli` in `next.config.ts`. The separate
`./dev exec -- npm run typecheck` gate uses the same compiler. Build-time
checks remain enabled so Next.js also checks its freshly generated route
types. No Go toolchain or `@typescript/native-preview` install is needed.
See [Next.js's CLI checker documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli)
and [TypeScript 7's release notes](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).

Before your first sandbox: build the sandbox image —

```sh
./dev exec -- docker build -t localhost/sweatshop-sandbox -f Containerfile.sandbox .
```

(or any engine-pullable image per project via the project's `image_ref`,
or `SWEATSHOP_SANDBOX_IMAGE` for the default).

## Provider keys & harness logins

At least one provider key in `.env.local` — the default routes are
derived from what's available (glm > openrouter > gloo):

| Env | What it unlocks |
| --- | --- |
| `ZAI_API_KEY` | GLM provider (Z.AI coding plan) + `web_search` (first backend) |
| `ANTHROPIC_SEARCH_API_KEY` | `web_search` backend via Claude's server-side search (not `ANTHROPIC_API_KEY`) |
| `TAVILY_API_KEY` | `web_search` backend (last in line) |
| `GLOO_API_KEY` | Gloo provider |
| `OPENROUTER_API_KEY` | OpenRouter provider |

`SWEATSHOP_DEFAULT_PROVIDER` + `SWEATSHOP_DEFAULT_MODEL` override the
derived default; per-surface pickers on `/settings` override those.

Harness logins (all optional, per harness):

- **pi** — provider-routed (one of the keys above); no separate login.
- **claude** — `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in
  `.env.local`. Single-user personal use.
- **cursor** — browser login; save `auth.json` under
  `data/harness-auth/cursor/`.
- **codex** — Log in with ChatGPT on `/settings` (in-app OAuth).

Git-host credentials for the `gh` / `forgejo` agent tools and sandbox
clones live as rows in the `git_credentials` sqlite table, editable on
`/settings` → Git credentials (shows only the start/end of each token).
`.env.local` is not read for these.

## Previews

Preview URLs are `pv-<slug>.<PREVIEW_BASE_DOMAIN>` (scheme per
`PREVIEW_URL_SCHEME`). Unset, the base falls back to
`previews.localhost` — fine on a laptop (publish the proxy with
`DEV_PUBLISH=...,80:3001` so `http://pv-<slug>.previews.localhost`
resolves to it), unreachable from other machines. On a home-server
setup set `PREVIEW_BASE_DOMAIN` to your wildcard domain. The proxy
listens on `PREVIEW_PROXY_PORT` (3001) and must be published where
browsers can reach it.

## Security posture

Single-user, LAN-only, no auth layer. Provider keys are env; git-host
and harness credentials are stored **plaintext** in sqlite by design
(reversible migration later). Secrets reach sandboxes read-scoped. Do
not expose this to the internet — add a real verifier first.
