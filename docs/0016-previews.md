# 0016 — Previews: long-running servers in sandboxes, and branch previews

Status: **approved (2026-10-03)** — direction agreed in chat with Chad
(plain follower loop that escalates to an agent only on failure; host
subdomains, not paths; flat `pv-` names; hand-rolled node:http proxy). Text
approved by Chad 2026-10-03; implementation in progress.

## Goal

Make it one click to see what a piece of work *does*. Most of the work
here is on web apps, so "see" means "open it in a browser".

1. **Any conversation or run can show its output.** An agent anywhere
   in a tree (chat, a run it started, an agent or harness stage inside
   it) starts a dev server in its sandbox. The top-level chat or run
   view then shows **Open preview** for as long as the server is up.
2. **Any branch can be previewed.** Pick project + branch and you get a
   dedicated sandbox serving it, kept current with the remote by a
   follower. A worker agent somewhere else only has to push. With no
   worker at all, it is a demo of a branch nobody is changing.

Both are the same object: a **Preview**.

## The Preview

A Preview is a long-running process in a sandbox that serves HTTP on
one port, reachable at a stable URL. It is owned by its **sandbox**,
not by whatever started it, so it outlives the turn, run, or stage that
started it. This is the same rule 0013 set for sandboxes outliving
runs. Background processes that do not serve HTTP (watchers, workers)
are out of scope for v1. The process model would fit them, but "you can
open it" is what keeps the UX obvious.

| field | meaning |
|---|---|
| `id` | `pv_…` |
| `slug` | DNS label in the URL (below), unique among live previews |
| `sandbox_id` | the sandbox it runs in (FK `sandboxes`) |
| `work_dir` | directory the command runs in (a repo inside the binding's workDir) |
| `command` | e.g. `npm run dev -- --host 0.0.0.0 --port $PORT` |
| `port` | the port inside the sandbox |
| `source` | `worktree` (whatever is in work_dir) or `branch` |
| `repo_id`, `branch` | for `branch` sources; the commit served is `head_sha` |
| `status` | `starting` · `healthy` · `crashed` · `stopped` · `failed` (follower gave up — see below) |
| `started_by` | conversation / run / stage id that called it, or `user` (attribution only, never ownership) |
| `last_request_at` | stamped by the proxy (idle signal) |
| `error`, timestamps | bounded failure reason; created/updated |

Logs go to a file inside the sandbox (`/work/.previews/<id>.log`), and
the UI tails them through `sandbox_exec`-style reads. They are not
stored in sqlite. The sandbox is the source of truth for process state,
and the row is the registry, the same split as `sandboxes`.

### Process supervision

The process runs **detached inside the sandbox** (`setsid nohup …
>log 2>&1 &`, pid written to `/work/.previews/<id>.pid`), not as a
child of the Next process. So a Next restart, dev reload, or `./dev`
restart does not kill previews. A tick (below) reconciles each row
against reality: is the pid alive, and does an HTTP GET on the port
answer? It moves the status between `starting` / `healthy` /
`crashed`. Restart = kill the pid group, then start again. A stopped
sandbox (reaped or manual Stop) leaves its previews `stopped`. Resuming
the sandbox does **not** auto-restart them in v1. The UI offers Start.

## How it is reached: host subdomains

Sandboxes publish no ports. The only route in is the private
`sweatshop-harness` podman network (0006), which the dev container is
on. So the Next process, or a small proxy beside it, reverse-proxies
`<slug>.preview.<base>` → `<sandbox-container>:<port>` over that
network. Sandboxes serving previews are joined to the network
(`connectContainerToHarnessNetwork` already does this for claude).

**Hosts, not paths.** `/preview/<id>/…` breaks most dev servers
(absolute asset URLs, HMR websocket paths, base-path config). With
subdomains the app sees itself at a root. Some apps will still need
changes (allowed-hosts checks such as Vite's `server.allowedHosts`,
Next's `allowedDevOrigins`, absolute URLs built from env). Agents
learn the host and pass it in (`PREVIEW_HOST` env, below). If an app
cannot cope, we revisit per app.

**WebSockets pass through** (HMR depends on them), as do streaming
responses.

**Names and TLS.** The homelab already has wildcard DNS + TLS for
`*.internal.crussell.io` on bees' Caddy (Route53 DNS-01). A *nested*
wildcard (`*.preview.internal.crussell.io`) is not covered by that
cert. Options, in order of preference:

1. Flat labels under the existing wildcard:
   `pv-<slug>.internal.crussell.io`. No new cert. One Caddy route
   (`@preview header_regexp Host ^pv-…`) forwards to sweatshop's proxy
   port on bee, which routes by Host. **Proposed.**
2. A new `*.preview.internal.crussell.io` site block (its own DNS-01
   cert). Cleaner names, one more cert and DNS record.

Either way it is a one-time change in `~/Code/cn` (bees Caddy route)
plus bee exposing the proxy port on its Nebula IP, the same pattern as
artifacts. The slug is `<branch-or-label>-<4 chars>`, DNS-safe, max 63
chars. LAN/Nebula-only by construction.

**Auth.** AGENTS.md's hard rule stands: no internet exposure without a
real verifier. "Share with a colleague" in v1 means someone on the
Nebula/LAN. Public sharing is a follow-up that has to ship that
verifier first.

**The proxy itself** is a separate listener started from
`instrumentation.ts` (Node `http` + `http-proxy`-style upgrade
handling). It does not run inside Next routes, because Next route
handlers cannot proxy WebSocket upgrades. It looks up `slug → (sandbox
ref, port)` in sqlite (a cached read), stamps `last_request_at` at
most once a minute, and answers unknown/stopped slugs with a small page
linking back to the preview in sweatshop. New dependency to approve:
a WebSocket-capable proxy (`http-proxy-3`, or hand-rolled on `node:http`
— roughly 80 lines; decide in phase 1).

## Two ways a Preview starts

### From an agent (worktree source)

New chat tools, available wherever the sandbox tools are (project chats,
agent stages; harnesses reach them through the parent):

- `start_preview({ dir?, command?, port?, label? })` runs in the
  caller's 0013 binding. If the command or port is omitted, it is
  inferred from the repo (`package.json` dev script; framework default
  port), and the project's sandbox config can set defaults
  (`preview_command`, `preview_port` columns on `sandbox_configs`). It
  injects `PORT` and `PREVIEW_HOST`. It is idempotent per `(sandbox,
  work_dir, port)`, so calling it again restarts that preview rather
  than adding another. Returns `{ url, status }` once healthy, or the
  log tail if it does not become healthy within a timeout. Errors are
  value-shaped, like the 0015 tools, so the model can repair them.
- `preview_status({ id? })` gives status + log tail.
- `stop_preview({ id })`.

Because a preview belongs to the sandbox and 0013 children share their
parent's binding, **the top-level chat or run sees every preview in its
sandbox** without any lineage tracking. A child run started with
`fresh: true` has its own sandbox. Its previews show on the run's own
view, and the parent chat shows them through the `start_machine` card.
v1 does not roll them up further.

### From the Previews page (branch source + follower)

`/previews` → **New preview**: project → repo → branch (listed via
`git ls-remote` through the `GitHost` credentials) → Create. This makes
a dedicated sandbox (new owner kind `preview`, workDir
`/work/<previewId>`), checks out the branch, runs install, and starts
the server, inferring command/port as above with an editable field on
the form.

**The follower** is a deterministic loop, not an agent. Each tick, for
each `branch` preview:

1. `git fetch` the branch. If the remote sha equals `head_sha`, stop here.
2. Fast-forward only. If it is not a fast-forward (force-push), hard
   reset to the remote. A preview tracks the branch and owns no local
   work, so a reset is correct.
3. If the lockfile / `package.json` changed, run install, then restart.
   Otherwise rely on the dev server's own reload. If the process is not
   up afterwards, restart it.
4. Wait for healthy, then record `head_sha`.

**On failure** (install fails, the server fails to boot, it stays
unhealthy after a restart) the preview goes `failed` with the error and
log tail, keeps serving nothing new, and raises a **needs-you** item in
`/inbox`: "Preview `feat/x` broke at `abc1234`". The item offers:

- **Fix it**: starts a conversation *attached to the preview's
  sandbox* (0013 attach — same sandbox, same dir), seeded with the
  failure. The agent can fix things locally (a missing env var, a cache)
  and restart. If the fix belongs in the branch, it says so. It does
  not push to someone else's branch unless asked.
- **Retry** and **Dismiss**.

One failure, one item. A new sha that boots cleanly clears it. This
reuses the attention model (0008). The mechanism is a `pending_inputs`
row of a new kind (`preview-failed`) on a synthetic preview
conversation, or a direct fold in `db/attention.ts`, decided in phase 3.

**Ticking.** One in-process timer from `instrumentation.ts` (every 30 s
while the server is up; `PREVIEW_TICK=off` disables), the same shape as
the reaper. It does both reconcile (all previews) and follow (branch
previews). Ticks never overlap, per preview. No Workflow SDK run per
preview: it is a cheap poll loop, and durable replay buys nothing when
the state lives in the sandbox and the row. Webhooks from Forgejo/GitHub
are a follow-up, a nudge that makes the tick immediate.

## Where it shows up (UX)

1. **Chat and run headers.** A pill appears whenever the bound sandbox
   has a live preview: `● feat/x · healthy · Open ↗`. With several, it
   becomes a menu. Colors: green healthy, amber starting, red
   crashed/failed. The menu holds Logs (a sheet with the tail), Restart,
   Stop. The pill also appears in the agent panel's header.
2. **In the transcript.** `start_preview` renders as a designed tool
   card (url, status, command, port), like the 0015 cards. Its status
   is live, not frozen at call time.
3. **Sandbox page.** A **Previews** section next to "Chats using it"
   and "Recent calls": each preview with status, command, port, source,
   started-by link, Open / Logs / Restart / Stop.
4. **`/previews`.** A top-level nav item beside Inbox, Machines,
   Sandboxes. It lists every preview that is not deleted (live first),
   with source, sha, last request, and the owning sandbox. The **New
   preview** form lives here, and so does the detail drawer for branch
   previews (follow history: sha → result, with the last N kept in a
   small `preview_events` table).
5. **⌘K.** "Open preview …" for live previews.

The sidebar gets no new dots. A failed branch preview surfaces through
the Inbox, so attention keeps one channel.

## Lifecycle and the reaper

- `busySandboxIds` counts a sandbox with a `starting`/`healthy`
  preview as busy, so the 30-minute chat window can no longer kill a
  demo.
- Previews have their own idle window. A preview with no proxied
  request for `GC_PREVIEW_STOP_HOURS` (default 12) is stopped by the
  reaper (process killed, row `stopped`). The sandbox's own windows then
  apply as usual. A `preview`-owned sandbox uses `GC_PREVIEW_DESTROY_DAYS`
  (default 7) after its last preview stops.
- Destroying a sandbox marks its previews `stopped`. Deleting a branch
  preview from `/previews` stops it and destroys its dedicated sandbox.
  For a worktree preview, Delete only stops it, because the sandbox
  belongs to the chat.

## Explicitly not changing

- Bindings (0013): a preview never changes which sandbox a chat or run
  is bound to. "Fix it" *attaches* a new chat to the preview's sandbox.
- Network policy stays recorded, not enforced.
- No auth layer, and therefore no exposure beyond LAN/Nebula.
- Postgres/other backends: still never. The new tables live in
  `sweatshop.db`.

## Phases

1. **Core + proxy.** `previews` table + store (`db/previews.ts`),
   process start/stop/reconcile in `lib/previews/` (through the
   provider seam: `SandboxHandle.run`), the Host-routing proxy listener
   with WebSocket upgrade, the reconcile tick, and the reaper changes.
   Then the cn change (bees Caddy route + bee port). Done when a
   manually created row serves a Vite and a Next dev app with HMR at
   `pv-<slug>.internal.crussell.io`.
2. **Agent tools + surfaces.** `start_preview`/`preview_status`/
   `stop_preview`, inference + config defaults, the tool card, the
   header pill (page + panel), and the sandbox-page section. Done when a
   project chat can say "start it" and the header gets an Open button.
3. **Branch previews.** `/previews` page + New form, the `preview`
   owner kind, the follower, `preview_events`, failure → Inbox item
   with Fix it / Retry / Dismiss, and ⌘K.
4. **Polish.** Idle windows tuned against real use, the "not running"
   landing page, log sheet streaming.

Each phase: typecheck/lint/test green. Store and follower logic are
unit-tested against temp DBs and a fake `SandboxHandle` (scripted git
and HTTP outcomes), with no podman. The proxy gets one integration test
behind an opt-in flag, as the claude spike does.

## Open questions

- Flat `pv-<slug>.internal.crussell.io` vs nested
  `*.preview.internal.crussell.io` (proposed: flat).
- Proxy dependency vs hand-rolled `node:http` upgrade handling.
- Should resuming a stopped sandbox auto-restart its previews? (v1: no.)

## Follow-ups (not now)

- Push webhooks to make follows immediate.
- Non-HTTP background processes under the same supervisor.
- Public share links (needs the real verifier first).
- Preview per PR, created by `create_pr`.
