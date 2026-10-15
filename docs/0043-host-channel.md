# 0043 — Host channel: `exec` against per-project hosts

Status: **approved (Chad, 2026-10-15); implementation on
`glen/0043-host-channel`.**

## Why

The repo-edit loop already works: a project's repos are cloned into a
sandbox, the agent edits, commits and opens PRs (`create_pr`), and for cn
the merge path already builds (`ci.yml` on the bees runner) and deploys
(`deploy.yml` drift fan-out). What is missing is the interactive half of
infrastructure work — the part that today happens through dsh/Glen over
SSH:

- verify live state after (or while) anything happens — cn's own ground
  rule: "when unsure, verify live state over SSH";
- service ops that deploys don't cover (restart the Caddy container after
  a route change; check a unit; read a journal tail);
- rollback when a deploy goes sideways;
- hosts that are not deploy targets at all — homeassistant (HAOS, SSH
  add-on + Supervisor API) being the standing example;
- API control of internal services (HA restarts/updates via
  authenticated POSTs — today's `web_fetch` is read-only GET).

Day-to-day scenarios this must cover (from the 2026-10-15 brainstorm):
flake bump + fleet redeploy; bump a pinned service (beszel); take a brand
new project (a dashboard) from empty repo to a real service behind
`dashboard.crussell.io` (image to zot, cn PR for quadlet + gateway route,
deploy, verify); troubleshoot homeassistant down (API + SSH + restarts).

dsh/Glen already holds full SSH + sudo to every host. This does not give
the household new powers — it gives sweatshop the same reach with more
process: every call is approved and audited.

## Decisions (Chad, 2026-10-15)

- **General channel first; bespoke verbs only where observed need.** No
  `deploy_host` / `restart_units` / `rollback_host` now. They will be
  built later as thin wrappers over this channel where usage shows the
  pattern (deploy gets an evidence card + per-host lock + detached run
  with wake; restart gets the lockout-sensitive confirm).
- **Approve every `exec` to start.** Policy modes come later
  ("yolo"/auto-approve, read-only allowlists, time-boxed grants); the
  audit rows this leaves behind are what will make those policies safe to
  grant.
- **One tool: `exec`.** A separate `request` tool was considered and
  dropped: `exec` + `curl` already does API calls, and host-scoping an
  HTTP tool would be pseudo-security — sandbox egress is unrestricted
  today and adding network sandboxing is consciously out of scope. The
  one thing `request` would have carried — API-token custody (the token
  never appearing in a command string, audit row, or model context) — is
  covered by the existing house convention instead: credentials live on
  the host that uses them, commands reference **paths, never contents**
  (`curl -H "Authorization: Bearer $(cat ~/.config/…/token)"`). The tool
  description teaches this.
- **Hosts are a per-project allow-list.** An entry is `name`, `address`,
  `user`, plus an optional informational `api_base` (where the host's API
  lives — surfaces in the tool description so the agent doesn't hunt for
  it; purely documentation, nothing mechanical reads it). No `kind`
  field: nothing in this layer assumes systemd, NixOS, or any config
  system — what a host *is* comes from the project's repos and their
  AGENTS.md/README files (cn's has the SSH section, HA's has the add-on
  mechanics). If sweatshop-specific per-project context is ever needed,
  it lands as a generic project-level thing, not per-host.
- **Credentials resolve through env vars, not a form.** The app's
  existing env plumbing (`.env.local` / quadlet environment) is the
  registry, keyed by host name (uppercased, non-alphanumerics → `_`):
  - `HOST_<NAME>_SSH_KEY_FILE` — path to a 0600 private key file. Keys
    are files rather than inline env values because podman env files
    don't take multiline values; env names the file, the file holds the
    key.
  - `HOST_<NAME>_SSH_PASSWORD` — inline (single-line), for hosts that
    only do password auth (the HA SSH add-on until it's converted to
    `authorized_keys`, a cn-side chore that makes the fleet uniform).

  Read at process start like every other credential; adding a host's
  credential = env edit + service restart, acceptable at homelab scale.
  No credential ever enters sqlite or the browser. Prefer key auth
  everywhere.
- **Credentials never enter a sandbox.** The channel is opened by the
  app process; sandboxed code — including harness agents — has no route
  to any host. The model only ever sees tool results.
- **Why not hosts-as-sandboxes** (rejected for now, recorded so it isn't
  re-litigated): a conversation bound to a host via the SandboxProvider
  seam makes host bash an unshaped verb (per-command approval over it is
  rubber-stamping), puts singleton shared hosts behind an interface whose
  every caller treats its subject as disposable (reaper stop, project
  delete destroy, preview ownership), and has no story for concurrent
  conversations on one host. The provider seam lift remains a good future
  design for its own use case (persistent work machines), separate doc.

## What changes

### 1. Host registry

- New table `project_hosts(id, project_id, name, address, user,
  api_base NULL, host_key_fp NULL, created_at)`, unique `(project_id,
  name)`. `address` is the SSH target (prefer Nebula IPs).
  `host_key_fp` pins the server key (see Transport).
- Managed on the project page beside repos: plain rows (name, address,
  user, api_base) — add/remove, no credential UI.
- The credential lookup is by host *name* through env, global to the app:
  two projects listing a host named `bees` share one credential. An
  `exec` against a host with no resolvable credential fails
  value-shaped with the exact env var it looked for.
- Removing a host deletes nothing historical; future tool calls against
  it fail value-shaped (`unknown host`).

### 2. The tool

Available to the agent wherever the project tools are (chat, panel,
child threads) on projects with at least one host. It suspends on the
**ask_chad approval path** (the `create_pr` mechanism, 0034 A): the card
shows the host and the exact command, Approve runs it, typing in the
thread denies with the text as the comment.

- `exec(host, command, timeout?)` — `command` is a string run via
  `bash -lc` on the host as its user. A string, not argv: with
  approve-every-call the card is the boundary and the audit row records
  the exact text, and strings compose (`is-active && journalctl …`)
  where argv arrays would just push the model into `bash -c` noise.
  Structured argv returns as a question in the policy work, where it
  would actually be load-bearing. Default timeout 120 s, max 900 s (the
  create_pr evidence cap); longer jobs run detached + polled per
  homelab-ops practice (background machinery arrives with the deploy
  verb, if ever). Result: exit code, stdout and stderr, each clipped
  (60 k chars, the `web_fetch` clip).
- Value-shaped errors: `unknown-host`, `no-credential` (naming the env
  var), `connect-failed` (with reason), `host-key-changed` (hard error —
  never interactive), `timeout` (with partial output).
- Tool descriptions enumerate the project's hosts (name, address, user,
  `api_base` when set) and instruct: host mechanics live in the
  project's repos — read the host's AGENTS.md/README before acting;
  treat lockout-sensitive services (nebula, sshd, networking, gateway
  caddy) per the repo's own rules; reference secret paths and variable
  names, never contents; API calls run as `exec` + `curl` on a host that
  holds the credential file.

The execution-plane split is deliberate and visible to the model: `bash`
runs in the conversation's sandbox; `exec` runs on a real host through
the app. Same conversation, two planes, no bridge between them.

### 3. Audit

- New table `host_commands(id, conversation_id, host_id, command TEXT,
  exit_code INT NULL, output TEXT NULL (clip), duration_ms INT NULL,
  created_at, resolved_at NULL)`. The row is written **before** execution
  and resolved after — a crash mid-command still shows the attempt. This
  table is the raw material the deferred policy modes will be designed
  against.
- `inspect` (the existing post-mortem surface) learns to include a
  conversation's host_commands alongside harness activity.
- Transcript card on the agent-cards shell: host + command, then exit +
  duration + clipped output.

### 4. Transport

- New dependency (decision flagged for approval): **ssh2** + `@types/ssh2`
  — the standard pure-JS SSH2 client. The app image has no `ssh` binary
  and shelling out is worse. One pooled connection per host with
  keepalive; connections are opened lazily and dropped on error.
- Host keys are **TOFU-pinned to the row**: the first successful connect
  writes `host_key_fp` (and says so in the audit row, so the first use
  is visible); every later connect must match. A mismatch is a hard
  `host-key-changed` error. No interactive prompts exist to answer.
- Egress is already proven: the app container reaches overlay hosts
  today (the forgejo GitHost seam talks to 10.10.0.2).

### 5. Tests

- A `HostTransport` seam (`lib/hosts/transport.ts`) with a fake for unit
  tests: approval gating, value-shaped errors, TOFU pinning, audit row
  lifecycle, clipping. No real SSH in the gate.
- Opt-in live spike in the house pattern (`HOST_SPIKE=1`) against a real
  host configured through env, like the cursor/claude spikes.

## Explicitly deferred (build only on observed need)

- Bespoke verbs over the channel: `deploy_host`, `restart_units`,
  `rollback_host` — with evidence cards, per-host locks, detached runs
  and wakes.
- Policy modes: auto-approve, read-only allowlists, time-boxed exec
  grants (approval fatigue is what defeats these systems, but the
  approve-every phase comes first).
- A `request` tool, revisited only if host-side credential staging for
  API calls proves painful in practice (it would carry exactly one
  thing: app-side token custody).
- Per-host or per-project runbook/notes fields; any `kind`/host-type
  metadata; any NixOS knowledge anywhere.
- Network sandboxing / egress restriction (consciously out of scope).

## Resolved questions (2026-10-15)

1. `api_base` — accepted, informational only.
2. Command string via `bash -lc` (not argv) — confirmed.
3. Credential input — no form; env vars as the registry, key files for
   key material (multiline env isn't representable in podman env files).
4. Timeouts — 120 s default / 900 s max, confirmed.
5. `request` — dropped; `exec` + `curl` covers it, and its host-scoping
   would have been pseudo-security next to unrestricted sandbox egress.
