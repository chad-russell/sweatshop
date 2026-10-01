# 0009 — Machines: durable stage machines on the Workflow SDK

Status: **proposed (2026-10-09)** — Chad approved the direction in chat
(machines in the db, project and non-project machines, harness / eve /
human stages). Phase 1a spike is in (`d062f7d`); everything below it
awaits approval of this doc.

## Goal

Build day-to-day work around reusable **machines**: a prompt enters a
user-defined state machine and flows stage to stage, each stage a fresh
agent conversation (or a human pause), with the run durable end to end.
Machines are entities Chad creates and edits in the app.

`run_ticket` (0004 Path B) is the hardcoded prototype of this: four
fixed `WorkflowAgent` phases, regex routing, durable only *between*
phases. Machines generalize it and replace it.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Durability grain | **Semantic agent steps**: harness stages run through `@ai-sdk/workflow-harness` `runHarnessAgentStep` with `stopWhen: isStepCount(1)`. One workflow step = one agent step (model call + its tool calls). | A crash loses at most one agent step; every durable boundary is a meaningful point (the step log *is* the transcript); pi is host-resident and cannot keep a turn alive across a suspension, so wall-clock cuts make it recompute the in-flight tail, which semantic boundaries avoid. Time slices use the same `HarnessWorkflowState`, so if a single step ever outgrows a host limit, switching is local to one function. |
| Machine storage | sqlite `machines` row with a zod-validated JSON `definition` + `version`. Each run freezes a snapshot of the definition. | CRUD from the app (an `agent/` file would be authored code — rebuilt by eve's watcher, not user data). Snapshots make edits safe while runs are in flight. |
| Workspace | Decided **per run** from the machine's `workspace`: `project` (one container provisioned at run start, the project's repos cloned, shared by **every** stage) or `none`. `scratch` (empty container, for pi in non-project machines) is reserved, not v1. | Chad's requirement: a project machine's stages all run in the project's sandbox. Project binding happens at run start, not on the machine, so one machine can serve any project. |
| Stage kinds | `harness` (pi / claude), `eve` (an eve chat session), `human` (a pause for Chad). Terminal = a stage with no `next`. | The three kinds Chad named. |
| Stage × workspace | `harness` requires `workspace: project` (rejected at validation otherwise). `eve` runs **in the run's container** for project machines and **with no sandbox** for `none`. `human` needs none. | Matches the requested matrix. |
| Transitions | Each stage lists `next: { to, when }[]`. One target → advance automatically. More than one → agent stages get a side-effect-free `transition({ to, reason })` tool (enum of allowed `to`); human stages render one button per target. The interpreter validates and commits. | The agent proposes, the workflow decides. A tool, not structured output — the harnesses don't uniformly support structured output. |
| Bounds | `maxVisits` per stage (default 3) and a per-stage step cap (default 400). Hitting either parks the run as `needs-attention`. | Review→rework loops can't run forever. |
| Context between stages | A fresh harness session / eve session per stage visit. The prompt is a **brief**: the run's original prompt, earlier stages' outcomes (final text, clipped), then the stage's instructions. Project machines also share the working tree itself. | "A new conversation per stage", without losing the thread. |

## Shape

```ts
type Stage =
  | { kind: "harness"; harness: "pi" | "claude"; model?: string;
      thinking?: "off" | "low" | "medium" | "high"; instructions: string }
  | { kind: "eve"; model?: string; instructions: string }
  | { kind: "human"; instructions: string };

type MachineDefinition = {
  workspace: "project" | "none";
  start: string;
  stages: Record<string, Stage & {
    title: string;
    next: { to: string; when?: string }[];   // [] = terminal
    maxVisits?: number;
  }>;
};
```

```
runMachine(runId)                     'use workflow' — the interpreter, single writer
  provision workspace                 step (project: container; none: nothing)
  loop until terminal:
    harness → loop harnessStep()      step per agent step (runHarnessAgentStep)
    eve     → startEveStage()         step (create session, operationId = stage visit)
              await stage hook        suspends, zero compute, until the turn settles
    human   → await gate hook         suspends until Chad answers (→ /inbox)
    commit transition                 step (machine_stage_runs + machine_runs)
  finally: remove container           step
```

## Proven (Phase 1a spike, `tests/machine-spike.integration.test.ts`)

Real models, one container from `provisionProjectSandbox`:

- **pi stage** (GLM 5.3 Flash): 3–4 semantic steps → `finished`.
- **claude stage** (Claude Code through the bridge): 3 steps →
  `finished`, then read pi's file and wrote `claude saw: written by pi`.
  **One container, two harnesses, each seeing the other's work.**
- Between every step the agent was rebuilt from scratch and the state
  round-tripped through JSON. That is what a fresh `"use step"` sees
  after a restart.

What it took (all in the spike commit):

- `@ai-sdk/workflow-harness` **1.0.132**, pinned exactly to match
  `@ai-sdk/harness` 1.0.132. Its peer dependency still says
  `workflow@^4`, so a scoped npm override points it at our
  `workflow@5.0.0-beta.58`. That's safe because the package only uses
  `getWritable()`.
- `ProvisionedSandbox` gains a real streaming `spawn` (`docker exec -i`).
  The claude bridge is a long-lived process, and the replay fallback
  can't host it.
- `connectContainerToHarnessNetwork(containerName)`: provisioned
  containers know their name, so they skip the eve marker scan.
- Sandbox image: `pnpm` 11.5.2 (the claude bridge bootstraps with
  `pnpm install`), plus a **non-root `sandbox` user with passwordless
  sudo**. Claude Code refuses its permission-skipping mode as root.
  This matches eve's own image (`vercel-sandbox`).

## Not yet proven: eve stages in the run's container

Harness stages share the container because the run hands them a
handle. Eve sessions are different: each session **owns** its sandbox,
and the built-in Docker environment always starts a new container. The
eve docs give the supported way to share one: a custom provider
(`defineSandboxProvider`) whose `start()` returns a *session-owned view*
of an existing resource. It keeps the shared container outside that
view's `stop` / `delete` hooks (`vendor/eve/docs/sandbox/index.mdx`,
"Reuse native resources across sessions").

The plan:

- **Binding.** A machine-stage session is created with
  `x-sweatshop-machine-run: <runId>` (lifted into principal attributes
  like `project`).
- **Attach.** The provider's `start()` looks up the run's container
  name and returns an exec-backed handle. Session state is
  `{ containerName }`; `resume()` reattaches. The stop and delete hooks
  are no-ops, because the run owns the container.
- **Open question.** Eve compiles one `environment` export per sandbox
  module. If the selector can't choose between eve's Docker environment
  and ours, the provider becomes **sweatshop's one container
  provider**: it provisions with our provisioner for ordinary project
  conversations and attaches for machine stages. That would also put
  Path A and Path B on one image and one provisioner. That's a good end
  state, but it's the biggest change here, so it gets its own spike
  (1b) before anything depends on it.
- **Completion.** Our mirror hook already sees every event. For
  sessions with a machine-run attribute, `turn.completed` POSTs to a
  Next route that resumes the stage hook (the token is the stage
  visit). That keeps the Workflow world inside the Next process.
  `operationId` makes the create idempotent, so a retried step finds
  the same session.
- **Transitions.** An eve-side `transition` tool, available only in
  machine sessions, ends the stage the same way the harness tool does.
  The stage is a real conversation, so Chad can talk to it before it
  transitions.

## Store

- `machines` (id, name, description, definition JSON, version,
  created/updated).
- `machine_runs` (id, machine_id, definition snapshot, project_id?,
  prompt, status, current_stage, container_name?, error,
  created/updated). Status values: `running | waiting | needs-attention
  | completed | failed | cancelled`.
- `machine_stage_runs` (run_id, seq, stage_id, kind, status,
  session_id, outcome, transition_to, started/ended).
- **Harness stages reuse `harness_events` / `harness_runs`,** keyed by
  the stage visit's session id (`mr_<run>_<seq>`), so
  `/h/<harness>/<id>` works unchanged. **Eve stages are ordinary
  conversations**, already mirrored. **Human gates** join `/inbox` as a
  new "needs you" card, like ticket gates do today.

## Phases

1. **a ✅** Harness spike (above). **b** Eve attach-provider spike.
   Answers the one-environment question and proves eve bash, pi and
   claude all working in one container.
2. Schema + zod definition validation + store + `/api/machines` CRUD +
   seed machines.
3. Engine: `runMachine` with harness and human stages, both workspace
   modes, bounds, transition tool, stage-hook routes.
4. Eve stages, using whichever provider shape 1b chose.
5. UI: a machines list and editor (JSON editor first, form later), and
   a run view with a stage timeline that links each stage to its
   `/h/...` or conversation. Human gates go in `/inbox`.
6. Triggers: run from a project page or from Chats, and a
   `start_machine` chat tool.
7. Port run_ticket as a seeded "ticket" machine. Harness stages get
   `create_pr` as a host tool. Then delete `workflows/run-ticket.ts`,
   `ticket_runs` and `/t`.

## Out of scope (v1)

- Parallel branches or fan-out.
- `scratch` workspaces.
- Per-tool approval gates inside harness stages (they keep today's
  bypass behaviour).
- Schedules as triggers.
- Cross-stage harness session resume (`resumeFrom`). Each visit is fresh
  by design.

## Open questions

1. If spike 1b shows eve needs a single provider, may it replace eve's
   Docker environment for **all** project conversations? That would mean
   our image (Debian node:24 + `sandbox` user) instead of eve's (Ubuntu
   + `vercel-sandbox`).
2. Where should the run view live? `/r/<runId>`, or under the project
   (`/p/<id>/runs/<runId>`) with non-project runs elsewhere?
