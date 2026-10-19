# 0050 — Codex harness (OpenAI ChatGPT subscription, in-app browser login)

Status: **v1 built + live-checked** (proposed 2026-10-12; built through
2026-10-19; see "As built" at the bottom).

## Why

`docs/ROADMAP.md` lists codex as a future harness. `@ai-sdk/harness-codex`
exists and follows the exact bridge seam claude (0006) and cursor (0038)
use — bridge process inside the sandbox, WebSocket back over the harness
network, per-kind port. Chad is on a ChatGPT **enterprise** subscription
and wants login through the browser, not an API key.

## What the research proved (adapter source, @ai-sdk/harness-codex@1.0.143)

Read from the published package (not docs alone):

- **Auth is env-carried, not file-carried.** The codex bridge (unlike
  cursor's CLI) never reads `auth.json`. The host adapter resolves the
  credential and forwards env vars to the bridge: `CODEX_API_KEY` +
  `OPENAI_BASE_URL` + the session `headers`. Same shape as claude's
  env-token — **no file planting needed**.
- **Native subscription is built in.** `resolveCodexAuthentication` →
  `readCodexSubscription` reads `CODEX_HOME/auth.json` (default
  `~/.codex`), requires `auth_mode:"chatgpt"` with
  `tokens.{access_token,refresh_token}` (`account_id` optional), and —
  key advantage over cursor — **refreshes near-expiry tokens itself**
  (5-minute window) and writes the refreshed file back atomically. The
  refresh-token stranding risk 0038 left open for cursor does not exist
  here, by construction.
- **Where CODEX_HOME points is ours.** The adapter reads
  `env.CODEX_HOME` first. Setting `CODEX_HOME=data/harness-auth/codex`
  in the app process (instrumentation, once at boot) makes the adapter
  read OUR file and refresh OUR file — the operator's real `~/.codex`
  (if any) is never touched, and nothing is copied into sandboxes.
- **Enterprise account header.** `readCodexSubscription` extracts
  `tokens.account_id` and returns `ChatGPT-Account-ID` as a request
  header — but on our sandbox the adapter's header injection
  (`addRequestTransformations`) doesn't exist, so it is NOT applied
  automatically. However `HarnessAgent({ headers })` is a designed
  constructor seam: the headers ride the session `start` message into
  the bridge's provider `http_headers`. We read `account_id` from our
  credential file and pass it there. (Verified in adapter + harness
  source: `startOpts.headers` → bridge `http_headers`.)
- **Auto-detect precedence guard:** with `auth` unset, the adapter
  prefers gateway/direct env credentials over the subscription. The
  app env must not carry `OPENAI_API_KEY`/`CODEX_API_KEY`/
  `AI_GATEWAY_API_KEY`; the spike asserts this and we fail fast with a
  clear message if one appears.
- **Stack:** `@ai-sdk/harness-codex@1.0.143` pairs exactly with our
  pins (`@ai-sdk/harness` 1.0.141, `provider-utils` 5.0.56). No stack
  bump (same situation as 0038's cursor). Peer `zod ^3.25||^4` — we're
  on zod 4. Security: the tool-relay bypass (GHSA-qw9h-448j-6rph,
  CVE-2026-64650) affects ≤1.0.28 only; 1.0.143 is patched.
- **Bootstrap:** adapter-managed — writes a bridge bundle under the
  sandbox HOME and runs `pnpm install --frozen-lockfile` (pulls
  `@openai/codex` 0.155.0). Our sandbox image already has pnpm
  (11.5.2) + node 24 + curl; **no image change**. First session per
  sandbox pays the install (~10 s), like cursor's CLI install.
- **Models/effort:** `createCodex({ reasoningEffort })` accepts
  `low|medium|high|xhigh|max` (exactly our `CLAUDE_EFFORTS` values);
  per-prompt model flows through `promptOpts.model ?? model`, so a
  route model overrides the adapter default. The adapter pins its own
  default to `gpt-5.5` deliberately (newer GPT-5.6 models use Responses
  Lite, which hides code-mode tools from the custom provider — upstream
  issue openai/codex#31894). We honor that: v1 offers `gpt-5.5` only;
  the live spike verifies whether more ids work and grows the list from
  evidence.
- **Limitations:** no built-in tool approvals (`permissionMode:
  'allow-all'`, same as claude/cursor today); cold-resumed threads lose
  apply_patch/view_image events.

## In-app browser login (the OAuth enterprise subscription)

The codex CLI's device flow, reimplemented server-side (no CLI in the
app process). All endpoints read from the codex CLI source
(`codex-rs/login/src/{device_code_auth,server,auth/manager}.rs`), same
client id the adapter itself uses for refresh
(`app_EMoamEEZ73f0CkXaXp7hrann`):

1. `POST /api/x/codex/login/start` — server POSTs
   `https://auth.openai.com/api/accounts/deviceauth/usercode`
   `{client_id}` → `{user_code, device_auth_id, interval}`.
2. The UI shows the code + opens `https://auth.openai.com/codex/device`.
   Chad signs in with his enterprise SSO **in his own browser** and
   picks the workspace — the workspace choice is what makes the
   account id enterprise-correct.
3. Server polls `…/api/accounts/deviceauth/token` on `interval`; on
   success it gets `authorization_code` + the PKCE verifier, exchanges
   at `https://auth.openai.com/oauth/token` (grant
   `authorization_code`, redirect
   `https://auth.openai.com/deviceauth/callback`), and receives
   access/refresh/id tokens.
4. `account_id` comes from the id_token's `chatgpt_account_id` claim
   (what the CLI persists as `tokens.account_id`). Compose
   `auth.json` = `{auth_mode:"chatgpt", tokens:{…}, last_refresh}` and
   save via `saveCodexCredential` (validate → 0600 atomic write, the
   same discipline as cursor's).

Device-code login must be enabled (personal security settings, or by
the workspace admin for enterprise). If it is blocked, the settings
page also keeps the documented fallback: paste/upload an `auth.json`
produced by `codex login` on any machine with a browser. Both paths
end at the same file; the file is the seam.

The endpoints are undocumented (source-derived). The spike proves the
whole flow once against the real issuer; breakage later degrades to
the paste fallback, not to a broken harness.

## Decisions

1. **Route** `{harness:"codex", model?, effort?}` — subscription only,
   nowhere to put a provider (ToS rule holds by construction, as
   claude/cursor). `effort` shares the `low..xhigh,max` enum. Surface
   `codex` resolves **global** only, like claude/cursor; project
   `allowed_harnesses` applies after resolution. Builtin default
   `{harness:"codex"}` (model unset = adapter's own `gpt-5.5`).
2. **Credential** lives at `data/harness-auth/codex/auth.json`
   (`HARNESS_AUTH_DIR` relocates the root; 0600; under `data/` so
   restic covers it; never in git/DB/logs). `CODEX_HOME` points the
   adapter at it; the adapter's own refresh keeps it current. Our
   `lib/harness-auth/codex.ts` mirrors cursor.ts's shape (parse, judge,
   save, status) minus planting — there is nothing to plant.
3. **Builder** (`workflows/chat/harness-agent.ts`): `createCodex({ port:
   harnessBridgePort("codex"), reasoningEffort: route.effort? })`,
   `headers: {ChatGPT-Account-ID}` when the file carries an account id.
   `auth` left default (auto) — with no API-key env vars present, auto
   resolves to the native subscription, which is the only mode we
   offer.
4. **Port** `codex: 4002` in `HARNESS_BRIDGE_PORTS` (per-kind ports,
   0038 amendment). Everything downstream (bridge kind union, sandbox
   adapter port list) keys off the record.
5. **Tool** `codex({task})` beside pi/claude/cursor — same background
   `harness_calls` path, wake, cancel, `/h/codex/<id>` view,
   `HarnessKind` + kind unions grow by one literal each (no DB
   migration; `kind` is plain text).
6. **Login UX** on `/settings` (mirrors the cursor row): status +
   expiry + account id, "Log in with ChatGPT" (device flow, polls,
   auto-saves), logout (delete file), and the paste-`auth.json`
   fallback. Codex is offered (tool, pickers, defaults) only when the
   file parses as a chatgpt login.
7. **Models** `CODEX_MODELS` starts as `[gpt-5.5]`; validation rejects
   unknown ids listing the offered set (the 0038 cursor lesson).

## Explicitly deferred

- API-key / AI-gateway modes for codex (subscription only, per the
  0021 decision 1 pattern).
- Baking the codex bridge deps into the sandbox image (first-use
  install is acceptable; revisit if it annoys).
- Codex `webSearch`, `codexConfig`, MCP servers.
- In-app login for cursor (0038's open Connect item) — 0050's login
  page is codex-scoped; the pattern generalizes later if wanted.

## Risks

- **Undocumented device endpoints** can change; fallback = paste file.
- **Reattached sessions keep the bridge env they were spawned with** —
  a token that expires mid-reattach-window 401s; per-call refresh
  covers the common path. Same class of risk as cursor's, bounded by
  sandbox lifetimes.
- **Enterprise device-code toggle** may need an admin flip before the
  first login works (the UI surfaces the issuer's error verbatim).

## Build order

1. Dep + `CODEX_HOME` wiring + `lib/harness-auth/codex.ts` + tests.
2. Route/surface/catalog/validation + settings plumbing + tests.
3. Builder branch, port, kind unions, mock-path tests.
4. Chat tool + UI (logo/labels, settings row, project harness list,
   instructions text) + tests.
5. Login routes + settings login UI (+ paste fallback) + tests.
6. `tests/codex-spike.integration.test.ts` (`CODEX_SPIKE=1`, opt-in):
   real login flow → real turn through the production builder →
   negative control (no credential). Findings may grow `CODEX_MODELS`.
7. AGENTS.md harness list updated; quality bar green throughout.

## As built (live, 2026-10-18/19)

The whole thing ran on bee over the production path (disposable sandbox →
`toNetworkSandboxSession` → `buildHarnessAgent` → `driveHarnessTurn`).

**Login as shipped.** The BROWSER flow is primary (Chad's enterprise
workspace BLOCKS device-code auth — confirmed live, which is why the
device flow is demoted to a disclosure): open the authorize URL, sign
in, pick the workspace, paste the `localhost:1455/auth/callback?…` URL
the browser lands on back into the settings panel (no local server
listens — the CLI's port-1455 trick skipped; the redirect matches the
issuer registration). The token exchange is form-encoded
(`application/x-www-form-urlencoded`), matching the CLI's
`exchange_code_for_tokens` byte-for-byte — verified live with a 200.
The account id is NOT a top-level id_token claim: it nests under
`"https://api.openai.com/auth"` (`chatgpt_account_id`, with
`chatgpt_plan_type` alongside) — fixed in 38d8d77 after the live login
proved the top-level read wrong. Device flow (kept for workspaces that
allow it) and paste-auth.json are secondary/tertiary.

**Models (CODEX_MODELS, live-verified against a ChatGPT team account):**

| model | live result |
| --- | --- |
| gpt-5.6-sol | full turn finished, scratch file + usage |
| gpt-5.6-terra | full turn finished |
| gpt-6-sol | full turn finished |
| gpt-6.1-sol | full turn finished |
| gpt-6-luna | full turn finished |
| gpt-6-astra | accepted slug, "Selected model is at capacity" — transient, offered (last) |
| gpt-5.5 | REJECTED — "not supported when using Codex with a ChatGPT account." |
| gpt-5.5-codex | rejected the same way |

The adapter's own `DEFAULT_CODEX_MODEL` (gpt-5.5) is API-key-era stale
— its upstream comment cites openai/codex#31894 for GPT-5.6, moot now
that the backend rejects 5.5 outright on subscriptions. Consequence:
`BUILTIN_DEFAULTS.codex` pins `gpt-5.6-sol` explicitly (an empty model
would send the rejected default) and the settings select has no "adapter
default" option anymore.

**Negative control.** No credential → the bridge fails with
"Missing environment variable: `CODEX_API_KEY`" — value-shaped,
auth-gated exactly as designed (no sandbox, no turn, no leak).

**CODEX_HOME/env notes.** `CODEX_HOME` is set per app process
(instrumentation) — the adapter resolves and refreshes
`auth.json` there; nothing is planted in the sandbox (unlike cursor's
token file) and the enterprise account id rides the bridge start
message as the `ChatGPT-Account-ID` header. The negative control
confirms the env-carried auth is the only path: empty `CODEX_HOME`
means no login, and the adapter falls through to an API-key variable
that does not exist.
