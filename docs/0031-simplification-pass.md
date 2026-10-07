# 0031 — Simplification pass

Status: **approved in chat 2026-10-08; implemented the same day as one
PR with sequenced commits** (`refactor(sandboxes)`/`refactor(projects)`/
`refactor(machines)` per cut). This doc records the decisions.

## Why

Before the go-live floor is built (ROADMAP Phase 1), a deliberate
re-litigation of accumulated policy. The trigger: ~4,400 lines across
machines + sandboxes, much of it policy that has never been exercised.

Usage evidence (live DB, 2026-10-08): **8** `sandbox_calls` rows ever
(across 5 conversations) — the entire 0011 per-call attribution
apparatus; **2** `sandbox_configs` rows (one is `default`, one an image
probe); **3** attached conversations (all preview dev work); 6 bound
conversations; 16 machine runs. Meanwhile human gates (9 stage runs)
and branching stages (think 1, ticket 3) **are** used — the machine
core earns its keep.

Principle: delete policy that a later invariant made unaskable; fold
entities that were never shared; collapse parallel engines; keep every
rule the usage data or the correctness argument supports.

## Cuts

### 1. Per-call sandbox attribution (0011) — dropped

`sandbox_calls` recorded which sandbox each tool call landed in. That
question existed because sandboxes could change under a conversation;
0013's binding-chosen-once invariant made it unaskable — the binding
*is* the record. 8 rows ever were written.

- Drop the `sandbox_calls` table (migration; no backfill — the rows are
  unused history), `recordSandboxCall`/`listCalls*`, the
  `CallAttribution` threading through `openConversationSandbox` /
  `openInheritedSandbox` / tool call sites.
- `db/sandbox-view.ts` sections that count activity from calls
  (chats-per-sandbox, per-conversation last-seen, `via`) derive from
  `conversations.sandbox_id`, `sandbox_attachments`, and
  `harness_events` instead.
- `inspect`'s call-attribution section goes; the binding display stays.
- `sandbox_attachments` STAYS (it is how attach works, and attach stays).

### 2. `sandbox_configs` entity → `projects.image_ref` (0004 fold)

A shareable config entity for a fleet that never exceeded one real
config. Projects want exactly one image each.

- Migration: resolve each project's `image_ref` through its
  `sandbox_config_id` (coalescing `default` → null), write
  `projects.image_ref`, drop `sandbox_configs` and
  `projects.sandbox_config_id`.
- `projectSandboxImage` becomes a single column read. Seed step for
  configs goes; `db:seed` keeps only machines.
- Project page: the config picker becomes an image field. Roadmap 1.4
  ("sandbox image in settings") simplifies to editing this field (plus
  pull/present validation, unchanged scope otherwise).
- **`network_policy` is deleted outright** — recorded-but-never-enforced
  is a pretense. It returns only if BoxLite (3.3) makes it real.

### 3. One reaper window

Per-owner-kind windows (conversation 30m/14d, run 10m/3d, preview
30m/7d) collapse to one pair: **stop 30m, destroy 7d**, env-overridable
(`GC_STOP_MINUTES`, `GC_DESTROY_DAYS`). `GC_RUN_*` and
`GC_PREVIEW_DESTROY_DAYS` go away; `GC_PREVIEW_STOP_HOURS` (the
preview-idle rule) stays. Nobody inspects a run's sandbox on day 4.

Kept: never-stop-busy (correctness), stale-`creating` drop, the
preview-idle pass.

### 4. Provisioning dedup (code)

`provisionProjectSandbox` + `ProvisionedSandbox` (the 0004 Path B
generation) are deleted; the only callers today are two opt-in spike
tests, which move to the provider. `SandboxHandle` becomes the one
handle type; `attachSandbox`'s internals fold into the provider;
`remove()` duplication goes.

### 5. Harness-turn engine dedup (code)

The chat `pi`/`claude` tool step (`workflows/chat/harness-step.ts`) and
the machine harness stage step (`workflows/machines/harness-step.ts` +
`harness-agent.ts`) both do open-binding → adapter → claim slot →
`runHarnessAgentStep` loop. Extract the shared drive-one-turn core;
chat keeps its `resumeFrom` persistence, machines keep state threading.

`uiChunkToModelPart` (~60 lines translating between two SDK stream
shapes) stays for now — **re-check during the 1.1 harness bump**, which
may make it unnecessary.

### 6. Machine editor demotion (UX)

The graph canvas becomes a **read-only viewer** (machine page + run
snapshot overlay — layout code stays). Editing is the JSON tab and the
agent tools (`edit_machine` ops are the agent surface and stay
unchanged). The DnD editing surface and inspector-editing UI are
removed (`components/machines` shrinks by roughly half). Usage says 2
seed machines; chat-to-edit is the daily path this app is building
toward.

### 7. Step-deps helper (small, with 5)

`workflows/{chat,machines}/deps.ts`: dynamic-import loaders for the
Node-touching modules steps use, statically importable because they
contain no static Node imports. The `"use step"` directive stays in
every function — the transform keys on it lexically, and a wrapper
cannot carry it (a closure cannot cross the record/replay boundary;
the step boundary IS the function). Saves ~40–60 lines and gives one
canonical declaration of what is Node-touching.

## Findings

- **The "step ceremony" is structural, mostly absorbed already.** The
  thin-step-delegates-to-a-core convention (0015) means most steps are
  one directive line + one import line + one call. The deps helper
  shaves the multi-import blocks. No further abstraction is possible
  without breaking the transform's model.
- **BoxLite is not a simplification lever.** The taxes that matter are
  SDK-shaped (step discipline, stream-shape translation), not
  container-shaped; a BoxLite swap re-validates `provision.ts`, the
  claude bridge, and services-as-siblings without deleting them. It
  stays the planned 3.3 spike, valued for enforcement (egress, secrets),
  not LOC.

## Explicitly kept (do not re-litigate)

Bindings chosen once + inheritance + attach mode (0013 core — every
pre-0013 pain it fixed was real); sandboxes outlive runs; never-stop-
busy; the one-harness-run-per-sandbox slot (keyed by conversation);
destroyed rows stay (cheaper than nulling bindings); stage kinds
harness/agent/human; transition-tool branching; `maxVisits`; runs as
conversations (0012); stage-visit conversations hidden.

## Delivery

One PR (Chad's call, overriding the phase-per-PR sketch below), one
commit per cut, the gate green at every commit. Delivered cuts, in
order: attribution drop → configs fold → reaper window → provisioning
dedup → harness dedup + deps helpers → editor demotion.

Migration notes that ship with it: migrations now apply with FKs OFF
(sqlite's documented schema-change posture — drizzle's migrator wraps
everything in one transaction where the pragma cannot be toggled, and
0007's trailing `PRAGMA foreign_keys=ON` taught us the replay harnesses
need the same posture); `scripts/migrate.mjs` and `tests/setup.ts`
assert `PRAGMA foreign_key_check` is clean afterwards. Dropping
`sandbox_configs` recreates `projects` (the `__new` table pattern from
0007 — renaming the old table would rewrite every child's FK clause).

Behavior notes beyond pure deletion: the shared harness sink filters
`fileChange`/`compaction` synthetic events for machine stages too
(previously only chats did); `/sandboxes` and its detail page show
bound chats and last activity instead of call counts; the machine
canvas no longer edits.

## Phases (original sketch — superseded by the one-PR delivery)

1. **Attribution drop** — migration, `binding.ts`, `db/sandbox-view.ts`,
   `inspect`, tests (`inspect`, `projects`, `sandbox-gc`).
2. **Configs fold** — migration, `lease.ts`, project page editors,
   tools, tests. May ride with roadmap 1.4.
3. **Reaper window collapse** — `reaper.ts`, env docs, `sandbox-gc`
   tests.
4. **Provisioning dedup** — `provision.ts`, `provider.ts`, spike tests.
5. **Harness dedup + deps helper** — the two harness steps, `deps.ts`.
6. **Editor demotion** — `components/machines`, JSON tab stays, viewer.

Estimated net: **−1,200 to −1,900 lines**, two entities gone
(attribution, sandbox configs), one parallel engine gone, one editing
surface gone.

## Out of scope

Preview/services policy (0016–0019) — explicitly continued, not backed
out (Chad, 2026-10-08); anything in the keep list; BoxLite (3.3).
