# 0017 — Preview setups: explicit commands, env, and declared services

Status: **approved (2026-10-04, chat) — phases 1–4 shipped same day**

Portability contract added and open questions resolved before
approval.

## Amendment — `seed` + the full setup editor (2026-10-04, later chat)

Direction agreed right after phase 4 shipped: the open-bible preview
boots schema-only (an empty site — no bibles), and the confirm form
still cannot edit `provision`/`services`. Two changes, one seam.

### Implementation notes (phases 5–7, shipped same day)

- **Phase 5–6 deviations.** The env block saves WITH the structural
  fields on confirm (the form prefills the full map, so per-preview env
  edits would silently rot the setup — sparse per-preview env remains
  an API/agent concept via `CreateBranchPreviewInput.env`). The setup
  editor lives as a **Setup** button on `/previews` (the project page
  is a chat surface; there is no card to host it). The shared field
  set is one component (`components/previews/setup-editor.tsx`) used
  by both hosts.
- **Phase 7 verification rode the worktree path, not a fresh create**:
  the bible-data contribution lives on a LOCAL branch
  (`chad/preview-seed` in the preview sandbox's clone — commit
  `feat(api): preview seed — offline fixture translations…`) because
  branch previews fetch from the project remote (biblica's GitHub) and
  nothing local can be followed until it lands upstream. From-scratch
  acceptance (teardown → create → serving a non-empty site) therefore
  still pends that landing; what IS verified end-to-end through the
  app: markers reset → restart → provision (payload + api migrations)
  → seed (fixtures + pages) → healthy → `/`, `/bibles`, and bible
  detail pages all 200 with content.
- **open-bible findings riding along** (setup fixes, not code): the
  web app renders bibles from the `api` postgres schema directly
  (`apps/web/src/lib/api-db.ts`), which only the ETL writes — with DBL
  credentials — so a preview needs (a) `apps/api`'s migrations in
  `provision` (payload's alone never create it), and (b) the seed
  writes fixtures there (`apps/api seed:preview`, bundled and offline).
  `payload migrate` PROMPTS interactively when the DB has been dev-mode
  pushed and hangs a launch for minutes — provision pipes the answer
  (`echo y | pnpm run payload:migrate`). The workspace `@open-bible/shared`
  package must be built or bible detail pages 500 on a missing
  `book-names` export — `install` is now `pnpm install && pnpm
  --filter @open-bible/shared run build`.

### Seed

The definition gains one field:

- `seed?: string` — one shell command at the repo root (the command
  carries its own `cd apps/web && …`, the `provision` convention).
  It runs **once per sandbox**, in the launch sequence's existing
  slot order: services healthy → `provision` → `seed` → server. The
  marker is a new `sandboxes.seeded_at` (`markSeeded`), deliberately
  independent of `services_provisioned_at` — an already-provisioned
  sandbox still seeds, and a failed seed never regresses provision
  state.
- Failure is provision's shape: non-zero exit parks the preview
  `failed` with a `tail -60`, the marker stays unset, Retry re-runs.
  Seed commands are idempotent **by convention** (open-bible's
  bundled seed already is — find-or-create), exactly like migrations.
- No per-preview override, no follower changes: seed writes
  sandbox-owned service state, like the services themselves. A
  branch preview runs its own checkout's seed implementation for
  free — same command, the branch's code.
- One command string covers every data archetype we have today:
  bundled (`pnpm run seed`), fetch-from-source (`seed:production` —
  sandboxes already have egress), restore-from-dump
  (`curl … | psql "$DATABASE_URL"`). Service data snapshots stay the
  follow-up below; this field is the seam they plug into. The
  trigger for building snapshots is cost — every branch preview is a
  fresh sandbox, so a slow or rate-limited fetch re-runs per preview.
- **Learning**: `discoverPreviewCandidates` prefills a candidate's
  `seed?` from script names `seed` / `db:seed` (a form fill, no
  guarantees). The agent path needs **no new tools**:
  `get/save_preview_setup` already carry the whole definition, and
  the learning flow is explore → boot → run the seed by hand
  (`sandbox_exec` / a harness shell) → verify the site renders WITH
  data → save. For open-bible the learning is the point: the bundled
  seed covers pages only, and `seed:production` still targets Mongo
  (pre-Payload legacy), so what "booted with data" means is exactly
  what the session is meant to sort out — possibly by contributing a
  translations seed back to the repo.

### The form becomes the setup editor

The `saveSetup` toggle is superseded. The confirm form edits the
FULL definition — workDir, install, command, port, env, provision,
seed, services (rows: name/image/port/command/env) — and on confirm:

- **structural fields** (workDir, install, provision, seed,
  services) save to the project's setup, always — they shape the
  sandbox and the launch path reads them from the setup, so silent
  one-offs of them are how a working setup rots;
- **per-preview fields** (command, port, label, sparse env) stay row
  overrides, as today.

An existing setup becomes editable without creating a preview: a
**Setup** button on `/previews` (beside New preview) opens the same
fields against the saved definition and saves in place — editing lives
in one place only, and the project page stays a chat surface.

### Phases

5. **Seed.** Schema field + `seeded_at` + launch-slot ordering +
   failure/retry + the discovery prefill; `confirmBranchPreview`
   passes `seed` through with `provision`. Unit tests (fake
   handle/provider, the launchPreview shape): slot ordering,
   once-markers, failure parks + Retry re-runs, a sandbox provisioned
   before seed existed still seeds.
6. **Setup editor.** The form edits the full definition; the toggle
   is removed; structural-save-on-confirm; the project-page edit
   entry.
7. **Prove it on open-bible.** The agent learns a seed that makes
   the preview render bibles (bundled pages seed + a real
   translations path — likely a repo contribution or the etl sync),
   saves the setup, and a from-scratch create serves a non-empty
   site.

## Implementation notes (deviations and decisions)

- **Phase 3/4.** A service `command` is ENTRYPOINT argv with compose
  semantics (quote-aware `splitArgs`), never a wrapped shell line —
  minio's ENTRYPOINT made `bash -lc` a subcommand. Liveness reads
  `docker inspect {{.State.Running}}`, not "did start succeed"
  (crash-looped containers start fine), which also makes a stale
  container self-heal into current args. `provision` and `install` run
  with the RESOLVED env (migrations need the same secrets and service
  URIs the app does). The once-per-sandbox `provisioned_at` marker
  lives on `sandboxes` rather than a service row (deviation from the
  table sketch — a services-less setup still needs the marker).
  Live acceptance (open-bible, main): services db (postgres 18) + s3
  (minio) as siblings, `${service:…}` addresses in DATABASE_URL/
  DATABASE_URI/S3_ENDPOINT, `payload migrate` via `provision`, and the
  homepage RENDERING at its pv- URL; a full teardown → one-shot
  create → serving cycle, with the services dying with the sandbox.

- **Phase 2.** `previewProjectId` resolves a preview's project through
  its repo (branch) or its sandbox owner — conversation or machine run
  (worktree) — so agent-started previews get the setup's env too. The
  setup store rejects a definition whose `repo` is not in the project.
  `${service:…}` references error value-shaped until phase 3 (never an
  empty address). The debug `.env` file is written 0600 by
  `startProcess`; the process env stays the source of truth. Live
  acceptance: open-bible's Payload error moved from `missing secret
  key` to `ECONNREFUSED 127.0.0.1:5432` (the app now fails only on the
  missing service — phase 3's job), and a rotated secret reached the
  next boot's `.env` after one restart.

## Implementation notes (phase 1 deviations and decisions)

- `listRemoteBranches` resolves the repo's GitHost credential and
  passes it as a one-shot `http.extraheader` (git is now in
  Containerfile.dev, but private repos also fail anonymous ls-remote —
  the credential seam only installed into sandboxes before). The token
  never touches disk.
- A provisioning failure keeps its half-made lease as `destroyed`
  history instead of deleting the row: the preview row's FK references
  it, and "never a half-made invisible thing" cuts both ways. The
  acquire path (`acquireSandbox`) still deletes its failed leases.
- Discovery scans `apps/* packages/* services/*` one level deep plus
  the repo root, in one shell round trip.
- Phase 1 leaves the definition's `env`/`services` schema in place but
  inert (phases 2–3); the confirm form does not edit them yet, and a
  re-save from the form preserves existing values.
- Also surfaced during live acceptance (ops): bee's user `podman.service`
  was wedged — its cgroup had accumulated rootless net helpers
  (passt/rootlessport) from API-created containers, a stop attempt
  could never complete (helpers in nested user namespaces can't be
  signaled by the user manager), and start was blocked. Unwedged the
  same day with zero downtime: the nine live helpers were MOVED (no
  signals, cgroup membership rewrite as root) into a holding
  `podman-net-hold.service`, the emptied unit restarted normally, and
  `./dev` is back on the default socket. The holders live in the
  holding unit until their containers restart naturally. Structural
  note for cn: any container created through the API socket parks its
  net helpers in `podman.service`'s cgroup forever, so the unit cannot
  restart cleanly while any such container runs — worth a deliberate
  fix (e.g. a per-connection service template) if it bites again.

Direction agreed in chat 2026-10-04, from the open-bible guinea-pig
test of 0016: the preview machinery works, but a real app needs an env
story, monorepos break root-only command inference, and a preview of a
full-stack app has nothing to point `DATABASE_URL` at. Decisions made
in that conversation, recorded here:

- **The declaration is the design, the substrate is a seam.** Services
  are declared in config ("deps declared, isolated per preview, env
  interpolated, lifecycle bound"); the v1 backend is sibling containers
  on `sweatshop-harness`, and a future VM tier runs the same
  declarations in-VM. The tiers coexist (0004's three-tier plan — the
  provider is picked per project), so siblings are not a stopgap.
- **No runtime heuristics.** Discovery (ex-inference) is an assisted,
  once-per-project form fill whose result is saved; after that,
  launches read the saved setup and never guess. This mirrors how
  Cursor cloud environments (`.cursor/environment.json`, agent-driven
  setup, repo → personal → team resolution) and Codespaces
  (`devcontainer.json` env + platform-held secrets) work.
- **Env values live in sweatshop's sqlite, plaintext** (the
  `git_credentials` precedent — the github token already lives there),
  masked in list views. Acceptable under the LAN-only, no-auth threat
  model; must be revisited the day the auth rule changes.
- One setup per project (no named profiles), config in the DB only (no
  committed `.sweatshop/preview.json` in v1). Per-preview sparse
  overrides at creation time, unsaved.
- The harness-network boundary model (any container on the network can
  reach preview services) is accepted for the v1 podman backend — it
  is a property of that backend, not of the design (see Portability
  contract).
- **Provider portability is a requirement, not a hope**: the same
  setup definitions must run unchanged under a future VM tier or an
  external sandbox provider (Railway sandboxes, Daytona, exe.dev —
  all remote substrates with exec and port exposure). See Portability
  contract.
- Both open leans resolved in chat 2026-10-04: `provision` runs once
  per sandbox; `save_preview_setup` needs no ask_chad gate.

## Goal

Make "open a preview of this project" a one-click, reliably-working
action for real apps, by making what a preview needs to run — where
the server lives in the repo, how deps install, what env it wants,
what services it depends on — **an explicit, saved, per-project
object** instead of per-launch guesses, and by giving that object a
service substrate.

## The Setup

A **preview setup** is one row per project:

| field | meaning |
|---|---|
| `id` | `psu_…` |
| `project_id` | unique — one setup per project in v1 |
| `definition` | zod-validated JSON (below), the `machines.definition` pattern |
| `created_at` / `updated_at` | |

The definition:

```jsonc
{
  "repo": "open-bible/open-bible",     // project_repos.id the setup runs
  "workDir": "apps/web",               // relative to the repo root
  "install": "pnpm install",           // run at provision + on dep change
  "provision": "pnpm -w run migrate",  // optional; once per sandbox, after services are healthy
  "seed": "cd apps/web && pnpm run seed",  // optional; once per sandbox, after provision — data, idempotent by convention
  "command": "pnpm run dev -H 0.0.0.0 -p $PORT",
  "port": 3000,
  "env": {
    "PAYLOAD_SECRET": "…",
    "DATABASE_URL": "postgresql://postgres:postgres@${service:db:5432}/openbible",
    "NEXT_PUBLIC_SERVER_URL": "${PREVIEW_URL}"
  },
  "services": [
    { "name": "db", "image": "docker.io/library/postgres:18-alpine",
      "env": { "POSTGRES_PASSWORD": "postgres" }, "port": 5432 },
    { "name": "s3", "image": "docker.io/minio/minio",
      "command": "server /data --console-address :9001", "port": 9000 }
  ]
}
```

### Env resolution and delivery

At launch, the process env is built in strict layers, later wins:

1. the setup's `env`,
2. per-preview overrides (a sparse map the creation form still allows,
   unsaved),
3. the platform's `PORT` / `HOST` / `PREVIEW_HOST` / `PREVIEW_URL`
   (0016) — always final, so a preview can never misroute itself.

Interpolation happens at resolution time, against the live sandbox:
`${service:<name>:<port>}` → the address the provider says that
service is reachable at from inside this sandbox (below), and
`${PREVIEW_HOST}` / `${PREVIEW_URL}` → this preview's values. An
unknown service name is a value-shaped error naming the setup and the
key. Delivery is **process env through `startProcess`'s existing `env`
channel** — nothing is written into the worktree, so the follower's
force-push `git clean` can never destroy it. (The log dir
`/work/.previews/` also gains `<id>.env` for debugging inside the
sandbox, mode 0600; the process env remains the source of truth.)

Values are masked (`••••••`) in list/card views and shown in the
editor. The agent tools see plaintext: the agent already operates
inside this trust boundary.

### Services

A service is a declared dependency of the sandbox, expressed as an OCI
image + env + port — never as a container name, network, or placement:

- **Registry**: `sandbox_services` rows (`id`, `sandbox_id`, `name`,
  `ref` — an opaque provider reference, like `sandboxes.ref`,
  `status` running/stopped/destroyed, `provisioned_at` — whether
  `provision` already ran, per sandbox). The same registry-vs-reality
  split as `sandboxes` and `previews`: the substrate is the truth, the
  row is the bookkeeping.
- **Contract vs v1 backend**: the contract a service backend must
  satisfy is only (a) the image is running, (b) the sandbox can dial
  `<address returned by the provider>:<port>`, (c) it stops when the
  sandbox is destroyed. The v1 podman backend satisfies it with
  sibling containers named `<sandbox-ref>-svc-<name>` on
  `sweatshop-harness` (unique, DNS-resolvable by the preview container
  and the proxy). No network aliases: podman DNS aliases are
  network-global, and two sandboxes each aliasing `db` would
  round-robin into each other's postgres. A VM backend would run the
  same images in-VM and answer `localhost`; an external provider
  answers with whatever it exposes (forwarded port, proxy host).
- **Lifecycle**: owned by the SANDBOX, like previews. `ensureServices`
  is idempotent (create-if-missing, start-if-stopped), called from
  branch-preview provisioning and from `launchPreview`, so a chat
  sandbox created before its project had services gets them on the
  next preview start. `destroySandbox` destroys service containers
  with the sandbox; the reaper marks rows. No publishing — the
  provider decides reachability.
- **Readiness**: probed **from inside the sandbox** (a TCP check via
  `handle.run` against the provider-resolved address, 10 s budget,
  retried on ensure) — portable, and it tests exactly what the app
  will experience, where the Next process may not be able to dial the
  service at all on a remote substrate. Only then does `provision`
  (once per sandbox) and the preview process start. A service that
  never becomes ready parks the preview `failed` with the service
  name.
- **Isolation granularity**: one set per sandbox, not per preview.
  Branch previews are 1:1 with their sandbox, so "isolated per
  preview" holds where it matters; previews sharing a chat sandbox
  share services (same repo, same worktree — sharing is correct and
  cheaper). Recorded deliberately.
- **Substrate seam**: the definition is substrate-free (see
  Portability contract). v1's `lib/sandboxes/services.ts` implements
  the backend interface with sibling containers through the podman
  socket; a VM provider runs the same declarations inside the VM; an
  external provider adapter runs them however it runs containers. No
  consumer of the definition knows which happened.

Explicitly rejected: mounting the podman socket into sandboxes so
agents can self-serve docker. That socket is root-equivalent for every
sandbox on the host; it would delete the isolation story entirely.

## Portability contract

What a sandbox substrate must provide for setups to run on it —
written down so review can hold the line, because substrate leakage
is how this design would quietly die:

1. **Exec with env**: run a command in a working directory with an env
   map (`SandboxHandle.run` — exists).
2. **A POSIX-ish filesystem with detached processes**: pid/log files
   under `/work/.previews/`, `setsid` supervision (exists; any Linux
   substrate has this).
3. **Service running, capability-flagged**: the provider declares
   whether it can run declared service images. A setup with services
   against a provider that cannot fails at creation with a
   value-shaped error naming the capability — never a half-started
   preview.
4. **A reachable preview endpoint**: the provider tells sweatshop
   where to dial the preview's port (`PreviewNetwork` — exists). Today
   the Next process dials container names on the harness network; a
   remote substrate answers with a forwarded address or tunnel, and
   the proxy uses that. The user-facing `pv-<slug>.internal.crussell.io`
   URL always comes from OUR proxy regardless of substrate — the
   stable-URL property is ours, not the provider's.
5. **Lifecycle events**: start/stop/destroy the sweatshop store can
   reconcile against (the reaper's registry-vs-reality loop — exists).

The audit rule: **no identifier of THIS substrate may appear in a
setup definition or an env value** — no sandbox/container names, no
sweatshop network names, no podman/docker specifics. (Pointing an env
value at a fixed, pre-existing service by address — a LAN minio, a
shared CI database — is legitimate configuration, not substrate
leakage; the rule bans wiring that would break when the sandbox moves,
not every address.) `${service:<name>:<port>}` and `${PREVIEW_URL}`
are the only wiring syntax, and both resolve per-substrate at launch.
A reviewer rejects a definition that names a sandbox or its network.
Under this rule the same setup runs on podman siblings, in-VM
compose, or a Railway/Daytona/exe.dev adapter, and adopting any of
them is a provider adapter + PreviewNetwork implementation — never a
migration of setup data.

## Setup lifecycle: discover once, explicit forever

`inferPreviewCommand` is reborn as `discoverPreviewCandidates(handle,
root)`: scan the checkout for packages with dev/start scripts (walking
workspace globs one level), return candidates `{ dir, pm, script,
command, port }[]`. It fills forms; it never launches anything.

- **New preview, no setup**: the form provisions the sandbox + clone
  first (visible `provisioning` state), then Discover lists candidates
  (`apps/web`, `apps/api`, …) with install/command/port prefilled per
  candidate. You edit, hit save — the setup row is written — and the
  preview launches. One decision, made once, with everything visible.
- **New preview, setup exists**: the form starts from the setup
  (repo/dir/command/port/env summary, services listed); edits are
  per-preview overrides unless you toggle "save to setup".
- **Agent path**: `start_preview` reads the setup when present
  (dir/command/port/env/services all defaulted from it) instead of
  inferring. New tools `get_preview_setup` / `save_preview_setup`
  (full definition, zod-validated, value-shaped errors — the 0015
  machine-tools shape) let a chat bootstrap the setup the way Cursor's
  agent-driven setup does: explore, try to boot, verify, save.

## Preview lifecycle changes (0016 fixes riding along)

- **`provisioning` status** (new, before `starting`): the preview row
  is inserted when the id is minted — before `acquireSandbox` — so a
  clone failure lands as a visible `failed` row with the reason (today
  it escapes as an unhandled 500 leaving no trace; the open-bible test
  hit exactly this). Provisioning failures also clean up any
  half-created sandbox lease.
- **Install is not part of the command.** `install` runs at
  branch-preview provisioning and on follower dep-change
  (`dependenciesChanged` stays); `command` is only the server. The
  health budget therefore measures boot, not `pnpm install` + boot —
  the flaw that would park slow-creating previews `failed` while still
  installing. `commandInstalls` and the lockfile→pm `installCommand`
  heuristic are deleted (the pm guess moves into discovery).
- **Follower**: dep-change → `install` (+ `provision` re-run if the
  sandbox's flag says it never succeeded), then relaunch. Force-push
  reset keeps excluding `node_modules` from `git clean`.
- **git in the dev image**: `Containerfile.dev` installs git — the
  New-preview branch picker runs `git ls-remote` from the Next process
  and is silently empty today. `listRemoteBranches` also stops
  swallowing errors: it reports why listing failed (no credentials,
  no git, no route) instead of returning `[]`.

## Superseded (deleted, not accumulated)

- `sandbox_configs.preview_command` / `preview_port` columns
  (migration drops them) and `projectPreviewDefaults` — per-project
  setups replace shared-config defaults.
- `inferPreviewCommand` (→ discovery), `installCommand`,
  `commandInstalls` (→ explicit `install`).

## Surfaces

- `/previews` → New preview: the two-phase form above. The list gains
  a small "setup" chip per project row (configured or not).
- Sandbox page: a **Services** block beside Previews (name, image,
  status, readiness), since services belong to the sandbox.
- Project page: a read-only "Preview setup" card (summary + edit link
  into the /previews form). Editing lives in one place only.
- Preview detail/logs sheet: the resolved env keys (masked values),
  because "which env did this boot with" is the first question a
  broken preview asks.

## Explicitly not changing

- Bindings (0013): setups never change which sandbox anything uses.
- Preview ownership (0016): previews still belong to sandboxes;
  services now do too.
- Network policy: still recorded, not enforced; the harness-network
  boundary model stands for the v1 podman backend (accepted in chat).
- The VM tier: a separate initiative (Follow-ups), not this doc.
- No auth, no exposure beyond LAN/Nebula. sqlite only.

## Phases

1. **Setup object + discover + create-failure fixes.** Table +
   zod definition + store; discovery scanner (unit-tested against a
   fixture checkout); `provisioning` status + early row insert +
   lease cleanup; git in `Containerfile.dev`; the two-phase New
   preview form. Done when a fresh project with no setup can be
   click-configured to a serving preview, and a bad repo URL produces
   a `failed` row, not a 500.
2. **Env.** Resolution layers + interpolation + delivery through
   `startProcess`; masked UI; agent tools (`get/save_preview_setup`,
   `start_preview` defaults); resolved-env-keys in the logs sheet.
   Done when a project whose app needs only env (no services) previews
   correctly, and rotating a value + restart picks it up.
3. **Services.** `sandbox_services` + `lib/sandboxes/services.ts` +
   ensure/readiness/provision-once + `${service:…}` interpolation +
   destroy/reaper integration + sandbox-page block. Unit tests fake
   the provider calls; one integration test behind an opt-in flag (the
   claude-spike pattern). Done when a declared postgres is dialable
   from the preview process by its provider-resolved address and dies
   with the sandbox.
4. **Prove it on open-bible.** Re-create the guinea pig with a real
   setup: db + s3 services, `PAYLOAD_SECRET` et al., migrations via
   `provision`, homepage rendering through
   `pv-<slug>.internal.crussell.io`. Acceptance is a from-scratch
   teardown → db:seed → form-configured → healthy → serving cycle,
   then teardown again.

Each phase: typecheck/lint/test green; store and service logic
unit-tested against temp DBs and fakes, podman only behind opt-in
integration flags.

## Open questions

(none — the two former questions, `provision`-once semantics and the
ask_chad gate on `save_preview_setup`, were resolved in chat
2026-10-04, both taking the lean.)

## Follow-ups (not now)

- The VM tier (0018 candidate): spike microsandbox/libkrun vs
  cloud-hypervisor on bees' KVM (0004's tiers), exec semantics,
  proxy/bridge reachability. Services ride along unchanged; sibling
  backend stays for docker-tier projects.
- External sandbox providers (Railway sandboxes, Daytona, exe.dev):
  legitimate under the portability contract — each is a
  `SandboxProvider` adapter + `PreviewNetwork` implementation +
  capability flag, with setup definitions unchanged. Requires the auth
  rule to grow up first (secrets and employer code on someone else's
  substrate), plus whatever egress rules the substrate imposes.
- Repo-committed `.sweatshop/preview.json` for the non-secret parts
  (Cursor's pattern) — reviewable, portable; a second source of truth
  to earn its place first.
- Service data snapshots (captured service state restored instead of
  a re-fetch per fresh sandbox — the amendment's `seed` field is the
  seam they plug into; build when a slow or rate-limited fetch re-runs
  too often across branch previews).
- Push webhooks → immediate follows (unchanged from 0016).
