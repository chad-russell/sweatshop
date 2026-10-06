# 0019 — Previews, projects, sandboxes: one owner per concept

Status: **approved by Chad 2026-10-06** (see "Decisions" — they
supersede the draft text below where they differ; the mechanical
groundwork shipped without a doc, see "Already done")

## Decisions (2026-10-06)

1. **Setup editing is project-page only.** Chad's manual setup/tweaks
   are rare (agents do >95%), so the dialog carries no per-preview
   command/port editing; those stay API/agent-only row overrides.
2. **Rename the stored field `provision` → `migrate`, no back-compat.**
   No dual-key read. Existing rows are rewritten by the `0032`
   migration (SQL `json_set`/`json_remove` on `preview_setups`), and
   the frozen-env cleanup is simply `previews.env = NULL` for existing
   rows — all of it is test data. Where stored data doesn't match, the
   migration deletes or rewrites it; code never accommodates the old
   shape.
3. **Inline previews on `/p`** (matches the project page owning its
   things).

## Why

A review of previews against projects and sandboxes (2026-10-05, after
0018) found the data model sound — project → shared sandbox config →
ONE preview setup per project → previews (instances) → sandbox services
— but the surfaces and code blur who owns what. Concretely:

- the setup editor is on the project page AND inside the New-preview
  dialog, and confirming a preview silently rewrites project config;
- the dialog freezes a copy of the env into each preview row, which then
  shadows later edits to the project's env (a bug, below);
- `command`/`port` live on both the setup and the preview row with no
  stated rule;
- the sandbox-config editor is nested inside the project's Overview;
- "Work surfaces" on `/p` is mostly links that duplicate the sidebar;
- "provision" names four different things;
- three functions answer "which project/repo root/setup does this
  preview belong to?" and the data layer is bypassed in several places.

This doc fixes placement and ownership. It adds no new mechanism.

## Already done (mechanical, no behavior change)

Commits `c4b9b9c`..`5a78135`: stale comments/copy removed; shared
`components/form-styles.ts` + `components/ui/native-select.tsx` (5
copy-pasted selects); setup editors moved to `components/project/`;
`lib/sandboxes/setup.ts` → `workspace.ts`; `listRemoteBranches` →
`lib/git-hosts/branches.ts` (takes url + credentials, no db);
`lib/previews/branch.ts` (616 lines) split into `branch.ts` (create
flow), `follow.ts` (follower, retry, dismiss), `context.ts` (shared
helpers). Typecheck, lint, 368 tests green at each step.

## Ownership rules (the principle)

| Concept | Owner / home | Edited |
|---|---|---|
| How the project runs (workDir, install, migrate, seed, default command/port, env, services) | the project's **preview setup** | project page only (and the agent tools) |
| Image, network policy | **sandbox config** (shared) | its own card, not inside Overview |
| Which branch, which port/command *for this server*, label | the **preview row** | New-preview dialog / per-preview actions |
| Platform vars (PORT, HOST, PREVIEW_*) | the platform | never |

A preview row stores only **deviations** from the setup. Never a copy.

## Changes

### 1. The dialog stops being a second setup editor (behavior)

- **A setup exists:** the dialog shows project, repo, branch, label, and
  a one-line summary of the setup (`pnpm run dev · :3000 · 2 services`)
  with "Edit on the project page →". No `SetupFields`, no save-back.
- **No setup yet** (the first-fill moment — discovery needs a
  provisioned checkout): keep today's discover → pick → edit flow, and
  the confirm saves the setup. Said plainly in the UI: "This saves the
  project's setup."
- `confirmBranchPreview` saves the setup only when none exists (drops
  the `setup.repo === p.repoId` special case, which existed because
  confirm could overwrite).
- The API keeps accepting `workDir/install/command/port/env` on create
  and confirm — the agent and tests use them — but they are *this
  preview's* values, never written to the setup once one exists.

### 2. Env: rows store sparse overrides only (bug fix)

Today the dialog sends the whole env block and `confirm` stores it in
`previews.env`; since row overrides beat the setup's env
(`lib/previews/env.ts`), later edits to the project env never reach
those previews. Fix: with change 1 the dialog no longer sends env when a
setup exists; first-fill sends env to the **setup** only (the row stays
`null`). Existing rows' `previews.env` is cleared in migration `0032` (test
data; no per-key reconciliation). Needs reproducing in a test before
the fix lands.

### 3. command/port: setup default, row instance (docs + UI)

The rule is already how the code works; state it. The project-page
editor labels them "Default command / port (a preview can override)",
and a preview whose command or port differs from the setup shows
"overrides setup" in its card. One setup per project stays v1; when a
preview targets a repo other than the setup's, the dialog says so
("setup is for `web`; this preview runs with its own values") instead of
silently applying row-only edits.

### 4. Sandbox card split from Overview (UI)

The project page becomes: header (name inline-editable, New chat) →
**Repos** → **Sandbox** (config picker, image ref, network policy, the
shared-with-N note) → **Preview setup** → **Previews** → **Danger
zone**. Same components and routes; only grouping and the name moving to
the header. A standalone `/sandbox-configs` page waits until configs are
created from the UI (still `db:seed`).

### 5. "Work surfaces" becomes the project's Previews (UI)

Drop the Machines link (global catalog, not project-scoped — the
sidebar and ⌘K already reach it). Replace the Previews link with the
project's previews inline (`PreviewList` with `project=` — the API
exists) and a "New preview" button pre-scoped to the project.

### 6. Vocabulary: `provision` → `migrate` (schema, migration)

"Provision" currently means sandbox creation, the preview create phase,
the setup's migrations step, and a column (`services_provisioned_at`)
that marks only the migrations step. Rename:

- setup field `provision` → `migrate` (no old-key read — the `0032`
  migration rewrites stored rows; the tool descriptions say `migrate`);
- column `sandboxes.services_provisioned_at` → `migrated_at`
  (drizzle migration `0032`, pure rename);
- UI label "Migrate — once per sandbox, after services are healthy".

"Provisioning" stays the preview-create phase and status, and sandbox
provisioning stays `lib/sandboxes/provision.ts`.

### 7. One resolver, one schema, one store layer (code)

- `lib/previews/context.ts` gains `resolvePreviewContext(preview)` →
  `{ projectId, repoRoot, setup }`, replacing `previewProjectId` and
  `repoRootFor` (service.ts), `previewContext` and `setupFor`
  (context.ts). Callers: service, follow, branch, the `?project=`
  filter.
- The service schema (`previewSetupServiceSchema`) moves to
  `lib/sandboxes/services.ts`'s side (a `lib/sandboxes/service-spec.ts`,
  pure) and `lib/previews/setup.ts` imports it — the dependency stops
  pointing from sandboxes into previews.
- One zod `previewOverridesSchema` (workDir, install, command, port,
  label, env, services, migrate, seed) parses create and confirm bodies;
  `envOf`/`servicesOf`/the inline confirm parsing are deleted, and
  `CreateBranchPreviewInput`/`ConfirmInput` are derived from it.
- Raw drizzle reads outside `db/` move in: the `/p` page's four queries
  become `getProjectOverview(db, id)` in `db/projects.ts`; the
  conversation/run lookups in the resolver become small `db/` functions;
  `/previews` project options likewise.
- `components/previews/new-preview.tsx` splits: a
  `use-branch-preview-form` hook (fetches, step machine, request body)
  and the presentational dialog.

## Not changing

- The `preview_setups` storage shape beyond the `migrate` rename, and the
  decision to keep the DB the single source of truth (repo-committed
  `.sweatshop/preview.json` stays the 0017 follow-up).
- Preview lifecycle semantics (follower, reaper, proxy, Inbox card).
- The agent tools' names and behavior (`get_/save_preview_setup`,
  `start_preview`); only the `provision` → `migrate` field and the
  dialog's save-back change what they observe.
- One setup per project.

## Phases (each: typecheck/lint/test green, store tests where behavior changes)

1. **Resolver + schema + store layer** (change 7, minus the hook split).
   Pure refactor; no behavior change.
2. **Env fix + dialog rework** (changes 1, 2, 3): failing test first for
   the shadowed-env bug; the one-time `previews.env` cleanup.
3. **Project page regrouping** (changes 4, 5).
4. **`provision` → `migrate`** (change 6): rename + `0032` (also
   clears `previews.env`); no back-compat read.
5. **Dialog hook split** (rest of change 7) — last, since phase 2
   rewrites that file.

## Implementation notes

- **Phase 1 shipped 2026-10-06** (`4d7fe62`..): `resolvePreviewContext` /
  `previewProjectId` in `lib/previews/context.ts` replace the three
  resolvers (worktree previews resolve repoRoot through the setup's
  repo, as before); the owner lookups are `getLeaseProjectId`
  (`db/sandboxes.ts`) and `getProjectRepo` (`db/projects.ts`).
  `ServiceSpec` + `serviceSpecSchema` live in
  `lib/sandboxes/service-spec.ts`; `lib/previews/overrides.ts`
  (`parsePreviewOverrides`) is the one create/confirm body parser —
  `envOf`/`servicesOf`/the inline confirm parsing are gone and
  `CreateBranchPreviewInput`/`ConfirmInput` derive from
  `PreviewOverrides`. `/p`, `/previews` and the branches route read
  through `db/projects.ts` (`getProjectOverview`, `listProjectsWithRepos`,
  `listProjectRepos`, `listGitCredentials`). Tests:
  `preview-overrides.test.ts`, `preview-context.test.ts`.
- One mild behavior difference worth knowing: a bad `port`/`env` on
  create/confirm now returns the schema's message (`port: …`,
  `env: …`) rather than the old hand-written strings; status stays 400.
- Left alone as out of scope: raw project reads in `app/page.tsx`,
  `app/r/[runId]/page.tsx`, `app/machines/[machineId]/page.tsx`.
- **Phase 2 shipped 2026-10-06.** Test-first: the shadowed-env bug was
  reproduced (`first-fill env lands in the setup only…`) before the fix.
  `confirmBranchPreview`: no setup → the confirmed values (env included)
  become the project's first setup and the row keeps NO env copy; a
  setup exists → it is never written, env is a sparse row override, and
  passing `provision`/`seed`/`services` is an error naming them (they
  are setup-level, shared once-per-sandbox — silently dropping them
  would hide the mistake). This removes the old "different repo is not
  rewritten" special case: nothing is ever rewritten. The dialog shows a
  one-line summary + "Edit on the project page →" when a setup exists
  (and a note when the setup's repo differs from the chosen one), sends
  only the label, and keeps the editor only for first fill.
  `PreviewView.overridesSetup` (command or port differs from the setup)
  drives an "overrides setup" marker in the preview list; the editor's
  labels now say "Default command / port". The `previews.env` cleanup
  for existing rows is still migration `0032` (phase 4). The dialog is
  not browser-verified (typecheck/lint/tests only).
- **Phase 3 shipped 2026-10-06.** `/p` is: header (New chat) → name
  (`ProjectNameEditor`, with the project id) → Repos → Sandbox
  (`ProjectSandboxEditor`, the former Overview's config half) → Preview
  setup → Previews (the project's `PreviewList` + a New preview button
  scoped to this project; the dialog hides its project picker when it
  is handed a single project) → Danger zone. "Overview" and "Work
  surfaces" are gone; the Machines link went with it. Verified by
  fetching the running dev server's `/p/open-bible`, `/previews?project=`
  and `/api/previews?project=` (200s, expected sections, no stale
  headings) — not clicked through in a browser.
- **Phase 4 shipped 2026-10-06.** Setup field `provision` → `migrate`
  (schema, overrides, editor label "Migrate — schema, once per sandbox
  after services are healthy", tool prompts, route docs, tests) and
  `sandboxes.services_provisioned_at` → `migrated_at`
  (`markServicesProvisioned` → `markMigrated`). Migration
  `0032_preview_migrate.sql`: column rename, `preview_setups.definition`
  rewritten via `json_set`/`json_remove` (rows without the key
  untouched), and `previews.env` set NULL for every row (the frozen
  copies from the old dialog; this is test data). Drizzle's generator
  needs a TTY for the rename prompt, so the SQL, journal entry and
  `0032_snapshot.json` (0031's snapshot with the one column renamed,
  chained by `prevId`) were written by hand; `drizzle-kit check` is
  clean and `generate` reports no schema drift. The migration was
  exercised against a DB built at 0031 with an old-shaped setup,
  a no-`provision` setup, a stamped sandbox and a row env: key renamed,
  plain row untouched, `migrated_at` kept its value, env cleared. No
  dual-key read anywhere, per decision 2. **Not yet applied to the live
  `data/sweatshop.db`** — run `./dev exec -- npm run db:migrate`
  (the running dev server holds the old shape until then).

