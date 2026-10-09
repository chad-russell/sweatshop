# 0036 — Preview-driven QA in machine runs

Status: **draft 2026-10-09 — direction agreed with Chad in chat: no new
concepts; every surface that works in a sandbox gets the preview
tools.** Found by the trial week's first ticket (WYC-1589,
TRIAL-FRICTION 2026-10-09).

## What

One rule: **anything that works in a sandbox gets the preview tools.**
Chats and agent stages already have them — one shared definition set
(`workflows/chat/preview-tools.ts`, "schemas and descriptions live here
once so the model sees the same tools everywhere") over shared cores
(`lib/agent/tools/previews.ts`). Harness stages do not:
`workflows/machines/harness-step.ts` hands pi/claude exactly two host
tools (`transition`, `propose_pr`). That gap is why WYC-1589's implement
stage apt-installed Postgres, hand-rolled an S3 stub, and ran a dev
server nothing could see — 5 of its 6.5 minutes.

The change: `harnessStep` spreads `previewTools(runner)` into the same
ToolSet, the runner calling the cores with the run's binding. The
`PreviewCaller` union already has the shape a stage needs
(`{ kind: "inherited", sessionId: <stageSessionId>, binding, projectId }`),
and `stageSandboxTools` in `workflows/machines/agent-step.ts` is the
working template — the whole function runs inside the stage's one
`"use step"`, so the cores are called directly, like `propose_pr`'s
summarizer already is. The full family comes along: `start_preview`,
`preview_status`, `stop_preview`, `get_preview_setup`,
`save_preview_setup` — the last two so the first run on a setup-less
project (GPL today) can bootstrap and persist install/command/port/env
once, after which every run is one-shot.

Nothing else changes: no new stage kinds, no machine-definition fields,
no new tables, no lifecycle coupling. Machine seeds get instruction
nudges only (data, not code): verify says a visual change gets QA'd
against a preview; implement says start one before claiming visual QA.

## How a ticket runs (WYC-1589 replayed)

1. **plan** — unchanged.
2. **implement** — edits, commits, then `start_preview` in the run's
   sandbox: services ensured per the project setup (postgres/minio
   siblings, not apt), `migrate`/`seed` once per sandbox, server
   detached with `PORT`/`PREVIEW_URL` injected; the tool returns the
   `pv-…` URL.
3. **verify** — calls `start_preview` for the same dir/port: idempotent
   per (sandbox, dir, port), it gets the SAME preview back. Re-starting
   is finding; stages never search for anything.
4. **gate** — waits indefinitely, unchanged. "No PR yet" is simply not
   approving. The run view's preview pill already shows it (previews
   are sandbox-scoped, and the run view binds the sandbox).
5. **iterate** — a chat attached to the preview's sandbox (the
   branch-preview "Fix it" pattern) drives further changes against the
   live app; the preview survives turns, runs, and gate holds.
6. **publish** — unchanged.

## Wrinkles the implementation settles

- **The `$PORT` convention**: a setup's server command must honor the
  injected `PORT` (GPL's `next dev -p 3006` hardcodes it). Discovery
  prefill should prefer scripts that take a port env; the setup editor
  already shows the command. Document the convention in the setup
  description text.
- **First-start cost**: services provision + install run at launch
  (0017 path), once per sandbox. Acceptable — the sandbox outlives the
  run, so a second ticket in the same conversation's sandbox skips it.
- **Lifetime**: the reaper stops idle previews (12 h) and idle sandboxes
  (30 min; services stop with data intact and resume per 0019). A gate
  held overnight costs one idempotent relaunch, not a rebuild.
- **Cancellation**: a cancelled run leaves its previews serving
  (sandbox-owned) — desirable: a cancel-at-gate like WYC-1589's keeps
  the app inspectable while the branch sits unmerged.
- **Where the URL lands**: the tool result (harness events, outcome
  text, `/h/<harness>/<sessionId>`). Chat transcript cards already
  render chat previews; add a harness tool-result card later only if
  the raw URL proves insufficient.
- **Seeds**: editing seeds after 0023 means either `npm run db:seed --
  --replace` (the recorded one-time-per-deploy dance) or `edit_machine`
  ops. Pick at implementation; say which in the PR.
- **Tests**: the machines suite gets a scripted harness stage that
  calls `start_preview` against the fake sandbox/preview seams (the
  `PREVIEW_E2E` live test already covers the real podman path).

## Non-goals

- **Run-inside-a-preview** — rejected in chat (2026-10-09): it couples
  run lifecycle to preview lifecycle, fights 0013's one-binding-per-run
  and 0016's sandbox-owned previews, and duplicates the `/previews`
  follower. That would be the special case this doc exists to avoid.
- **New machine outcomes** (push-only / no-PR publish modes) — deferred
  by decision; the indefinite gate plus preview iteration is the
  trial-week answer. Revisit with evidence.
- **0035's browser and screenshot attach** — the companion, not a
  dependency: preview tools without a browser still mean hand-installed
  Chromium for visual QA. Either can land first; the full loop needs
  both.
