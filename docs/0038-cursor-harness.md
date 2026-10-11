# 0038 — Cursor harness, browser-login auth (and the road to in-app auth)

Status: **2026-10-11 — approved by Chad; v1 built** (branch
`feat/cursor-harness`). The spike and the adapter fix shipped in #80.

## Why this exists

`docs/ROADMAP.md` 3.2 and `docs/0021` record Cursor as **blocked on a
user API key** ("no interactive-login path in the adapter"; Chad is on
enterprise SSO and probably has no key). The spike below shows that
premise is out of date: Cursor's browser login (`agent login`, OAuth)
writes a credential file the CLI reuses headless, and
`@ai-sdk/harness-cursor` drives the CLI through the same bridge seam as
claude (0006/0013). Cursor does not need an API key.

## What the spike proved (2026-10-11, bee)

Real path throughout: podman sandbox → `toNetworkSandboxSession` →
`HarnessAgent` + `createCursor` → `driveHarnessTurn` (one semantic step
per call, the production grain). `tests/cursor-spike.integration.test.ts`
(opt-in, `CURSOR_SPIKE=1`).

- **Cursor CLI browser login:** `agent login` stores
  `~/.config/cursor/auth.json` (0600) = `{accessToken, refreshToken}`
  (JWTs, ~60-day expiry). Copying only that file into a fresh HOME makes
  `agent status` report logged in and `agent --trust -p …` answer
  headless.
- **What does NOT work:** the access token as `CURSOR_API_KEY` (rejected
  as an invalid key) or `CURSOR_AUTH_TOKEN` (not logged in). The
  adapter's built-in "native subscription" shortcut
  (`cursor-subscription.ts`: reads `auth.json`, forwards the access token
  as `CURSOR_API_KEY`) therefore does not authenticate the CLI. We
  bypass it by planting the **file**, not an env var.
- **Through the adapter:** with `auth.json` planted in the CLI's private
  HOME (`~/.ai-sdk-harness/.harness-bootstrap/cursor/implementation/home/
  .config/cursor/`), a turn runs to `finished` and the agent created the
  requested file in the sandbox workDir.
- **Negative control:** same turn without the file →
  `ACP session initialization failed: Authentication required`, turn
  `failed`. So the credential, not something ambient, is what
  authenticates.
- **Refresh:** `auth.json` was byte-identical after a turn (md5), so no
  refresh happened in a short run; refresh behaviour near expiry is
  **unverified** (see Risks).
- **Stack:** `@ai-sdk/harness-cursor` **1.0.55** pairs exactly with the
  pinned `@ai-sdk/harness` 1.0.141 (needs `harness-acp` 1.0.80). No stack
  bump (1.0.62, the latest, needs harness 1.0.148). Two new packages:
  `harness-cursor`, `harness-acp`.

### A bug the spike found (fixed in this branch)

`lib/sandboxes/ai-sdk-adapter.ts` wrote files as a single
`printf '<base64>' | base64 -d`. One exec argument is capped at 128 KiB
by Linux, so any file over ~96 KB failed with `spawn E2BIG`. The ACP
bridge bundle is ~126 KB, so cursor (and any ACP harness) could never
bootstrap. `writeBytes` now appends base64 in 64 KiB chunks to a temp
file and decodes once; `tests/sandbox-write-bytes.test.ts` round-trips
400 KB through real bash with the same cap. Independent of cursor — any
large `writeFile` was one wrong size away from this.

## Decision: what v1 is

Mirror claude (0006 amendment), with the credential held by the app, not
the environment.

1. **Route.** Add `{harness:"cursor", model?}` (0021 already designed
   the slot; subscription only — the schema has no provider field, so the
   ToS rule holds by construction, as for claude). `resolveRoute` for
   cursor = global, never inheriting a chat/pi route; project
   `allowed_harnesses` applies after resolution.
2. **Tool.** `cursor` beside `pi`/`claude`, on the same background
   `harness_calls` path (0022): same slot, wake, cancel, `/h/cursor/<id>`
   view. `chat_harness_state` keeps `resumeFrom` for cross-call
   continuity.
3. **Credential.** The browser-login `auth.json` lives in
   `data/harness-auth/cursor/auth.json` (0600; under `data/`, so the
   nightly restic already covers it; never in git, never in the DB,
   never logged). The builder reads it per call and the harness-call step
   plants it into the CLI's private HOME in the sandbox before the turn
   (env-var base64 transport, as the spike does — never argv). Cursor is
   offered only when the file exists and parses (as claude is gated on
   its token).
4. **Where the file lands.** The CLI's private HOME is under the
   adapter's state dir; the spike resolved it by `find` after bootstrap.
   The build derives it from the adapter's documented layout
   (`<sandbox HOME>/.ai-sdk-harness/.harness-bootstrap/cursor/
   implementation/home`) and verifies with `agent status` once per
   sandbox, failing value-shaped ("cursor is not logged in — see
   /settings") rather than as an opaque bridge error.
5. **Image.** The adapter installs the CLI at first use with
   `curl https://cursor.com/install | bash`, and the stock sandbox image
   has no `curl`. Add `curl` to `Containerfile.sandbox` (small), and
   consider baking the CLI into the image later to avoid the ~10 s
   install per sandbox (the roadmap already notes this).
6. **Trust / permissions.** Headless `agent` stops at a Workspace Trust
   prompt without `--trust`; the adapter's ACP session answers
   permission requests itself (the spike turn completed), so the build
   confirms what the adapter does with `session/request_permission` and
   records it, rather than assuming allow-all.

## The road to authenticating through the site (Chad's goal)

v1 deliberately stops at "Chad runs `agent login` once and drops the
file in." The destination is a Connect button in `/settings` for both
claude and cursor. The shape that fits what we now know:

- **Cursor:** `NO_OPEN_BROWSER=1 agent login` prints the login URL and
  waits for the browser flow to complete, then writes `auth.json`. A
  server-side "connect" can run exactly that in a throwaway sandbox (or a
  host child process), stream the printed URL to the page, wait for
  `auth.json` to appear, and store it. Open question: whether the login
  callback requires a loopback listener reachable from Chad's browser
  (the CLI is on bee/in a sandbox, the browser on his laptop/phone) — to
  be tested with the URL printed, not assumed.
- **Claude:** `claude setup-token` is the same pattern (prints a URL,
  returns a long-lived token the app already stores as
  `CLAUDE_CODE_OAUTH_TOKEN`). Same "connect" flow, a different command
  and parser.
- A shared "harness credential" store (table or `data/harness-auth/`)
  with a per-harness driver (start login, surface URL, capture result,
  report status/expiry) would replace the env var for claude too. That
  is its own design (a later doc); 0038 v1 just keeps the credential
  behind one read function so that swap is local.

## Risks and open questions

- **Credential exposure.** The file includes a refresh token and sits
  inside a sandbox the agent can read and exfiltrate over the network.
  Same class as claude's setup-token; contained by the single-user LAN
  model. The sandbox `network_policy` (recorded, not enforced) is the
  eventual mitigation.
- **Expiry/refresh.** ~60-day tokens; near-expiry refresh by the CLI
  inside a sandbox would rewrite the file there and strand the host
  copy. The build should copy the file back out (or re-plant from the
  host each call and treat the in-sandbox file as read-only cache) and
  surface expiry in `/settings`. Needs a test near expiry; not done.
- **Account.** The only logged-in account is the employer SSO one. The
  "subscription harness" ToS reasoning in 0021 is assumed to cover this
  (single-user, personal use, no resale); worth Chad's explicit nod, as
  it was for claude.
- **Adapter quality.** `harness-cursor` is young (1.0.x, patches
  weekly); we pin exactly like the others and bump deliberately.

## Build plan (after approval)

1. Deps: `@ai-sdk/harness-cursor@1.0.55` (+ `harness-acp@1.0.80`,
   transitive), exact pins, `npm ci` via deploy.
2. `lib/providers/route.ts`: cursor route + resolution + availability;
   catalog/settings surface (model picker via the CLI's model list or a
   static list); schema tests in the existing style.
3. `lib/harness-auth/cursor.ts`: read/validate/plant/health (one seam
   for the future Connect flow), with a fake-sandbox unit test.
4. `workflows/chat/harness-agent.ts` builder branch; `cursor` tool in
   the chat tool set; `/h/cursor/<id>` already generic.
5. `Containerfile.sandbox`: `curl`; rebuild image.
6. `/settings`: status (logged in as, expires in N days).
7. Live: `CURSOR_SPIKE=1` stays as the opt-in check; add a route-driven
   variant like `CLAUDE_SPIKE`.

## As built (v1)

Matches the plan above, with these specifics:

- `lib/harness-auth/cursor.ts` — the seam: `cursorCredential()` (sync;
  missing / invalid / expired are value-shaped, a login within 1 h of
  expiry counts as expired), `saveCursorCredential` (validates, 0600,
  atomic rename), `plantCursorCredential` (env-var base64 into
  `$HOME/.ai-sdk-harness/.harness-bootstrap/cursor/implementation/home/
  .config/cursor/auth.json` — `$HOME` expands inside the sandbox, so no
  path is guessed from the host). `HARNESS_AUTH_DIR` relocates the root.
- Planting happens in `harnessAdvanceStep` **before** the adapter's first
  bootstrap and again on every step (the host copy is the source of truth;
  the in-sandbox file is a cache). A missing/expired login fails the call
  as a `FatalError` with the fix in the message.
- The adapter runs with its default `auth`. `direct` was tried on paper and
  rejected: it makes the adapter's native-subscription shortcut MORE eager
  (it would forward the access token as `CURSOR_API_KEY`, which the CLI
  rejects) and logs a warning. With no `CURSOR_API_KEY` in the app's env
  the shortcut forwards nothing and the planted file authenticates.
- Route: `{harness:"cursor", model?}`; surface `cursor`; global default
  `{harness:"cursor"}`; allowed in project `allowed_harnesses`;
  validation needs a usable login. The model list is a curated slice of
  `agent --list-models` (`CURSOR_MODELS`), `auto` first.
- Chat tool `cursor` (project + sandbox chats, beside pi/claude), the
  generic `/h/cursor/<id>` view, wake chip, cancel — all through the
  existing 0022 path; `harness_calls.kind` is plain text, so no migration.
- `/settings`: login status and expiry, default-model picker. Project page:
  `cursor` in the allowed-harnesses list.
- `Containerfile.sandbox` gains `curl`. Until the base image is rebuilt
  (`./dev exec -- docker build -t localhost/sweatshop-sandbox -f
  Containerfile.sandbox .`), existing sandboxes cannot install the CLI.
- Tests: credential parse/store/plant (real bash round trip for the plant),
  route schema/validation/resolution, the settings write path, tool gating,
  and the start gate. Live: `tests/cursor-spike.integration.test.ts` now
  drives the production builder + plant order; the negative control
  (nothing planted) fails "Authentication required".

### Still open

- Near-expiry refresh was not exercised (tokens last ~60 days); the host
  copy is re-planted every step, so a CLI-side refresh in a sandbox cannot
  strand it, but it also means a refreshed token is not captured back. If
  the refresh token proves single-use, the Connect flow (or a copy-back)
  becomes necessary rather than optional.
- Permission requests: the adapter's default permission mode is
  `allow-all` (acp-v1-harness.ts); the spike turn completed without
  prompts. That matches how claude runs today; revisit with the sandbox
  `network_policy`.
