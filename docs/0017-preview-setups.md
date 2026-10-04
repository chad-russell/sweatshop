# 0017 — Preview setups: explicit commands, env, and declared services

Status: **draft (awaiting Chad's approval)**

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
  reach preview services) is accepted for now.

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
`${service:<name>:<port>}` → the service's container name (below),
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

A service is a declared container the sandbox owns:

- **Registry**: `sandbox_services` rows (`id`, `sandbox_id`, `name`,
  `container_ref`, `status` running/stopped/destroyed, `provisioned_at`
  — whether `provision` already ran, per sandbox). The same
  registry-vs-reality split as `sandboxes` and `previews`: the
  container is the truth, the row is the bookkeeping.
- **Identity**: containers are named `<sandbox-ref>-svc-<name>` on the
  `sweatshop-harness` network — unique, DNS-resolvable by the preview
  container and the proxy. No network aliases: podman DNS aliases are
  network-global, and two sandboxes each aliasing `db` would
  round-robin into each other's postgres.
- **Lifecycle**: owned by the SANDBOX, like previews. `ensureServices`
  is idempotent (create-if-missing, start-if-stopped), called from
  branch-preview provisioning and from `launchPreview`, so a chat
  sandbox created before its project had services gets them on the
  next preview start. `destroySandbox` destroys service containers
  with the sandbox; the reaper marks rows. No publishing — same
  network, direct dial.
- **Readiness**: after start, a TCP probe per service's `port`
  (10 s budget, retried on ensure). Only then does `provision` (once
  per sandbox) and the preview process start. A service that never
  becomes ready parks the preview `failed` with the service name.
- **Isolation granularity**: one set per sandbox, not per preview.
  Branch previews are 1:1 with their sandbox, so "isolated per
  preview" holds where it matters; previews sharing a chat sandbox
  share services (same repo, same worktree — sharing is correct and
  cheaper). Recorded deliberately.
- **Substrate seam**: the definition is substrate-free. v1's
  `lib/sandboxes/services.ts` implements it with sibling containers
  through the podman socket; a future VM provider (see Follow-ups)
  runs the same declarations inside the VM. No consumer of the
  definition knows which happened.

Explicitly rejected: mounting the podman socket into sandboxes so
agents can self-serve docker. That socket is root-equivalent for every
sandbox on the host; it would delete the isolation story entirely.

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
  boundary model stands (accepted in chat).
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
   the docker calls; one integration test behind an opt-in flag (the
   claude-spike pattern). Done when a declared postgres is dialable
   from the preview container by name and dies with the sandbox.
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

- `provision` once per sandbox — is once right, or rerun after
  force-push resets (schema drift across rewrites)? Lean: once;
  `provision` is written to be idempotent anyway.
- Should `save_preview_setup` require an ask_chad confirmation before
  first write (secrets entering the DB via a model)? Lean: no — the
  editor is the same trust boundary — but cheap to add later.

## Follow-ups (not now)

- The VM tier (0018 candidate): spike microsandbox/libkrun vs
  cloud-hypervisor on bees' KVM (0004's tiers), exec semantics,
  proxy/bridge reachability. Services ride along unchanged; sibling
  backend stays for docker-tier projects.
- Repo-committed `.sweatshop/preview.json` for the non-secret parts
  (Cursor's pattern) — reviewable, portable; a second source of truth
  to earn its place first.
- Service data snapshots / seed images (a preview starting from a
  meaningful dataset, not empty postgres).
- Push webhooks → immediate follows (unchanged from 0016).
