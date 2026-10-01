# 0009 — Machines: durable stage machines on the Workflow SDK

Status: **shipped (2026-10-09)** — approved as written with one
amendment (eve stages unsandboxed, spike 1b dropped, below); all phases
built and verified live. See "Shipped" at the end.

## Amendment (2026-10-09): eve stages run unsandboxed

Chad: "99% of everything I'd want sandboxes for could use external
harnesses only" — coding is harness work. So an `eve` stage is always
a plain conversation with no sandbox, in project and non-project
machines alike; only `harness` stages touch the run's container. This
removes the custom attach-provider (and the one-environment question)
from v1 entirely. A future VM sandbox tier does not change the
calculus: the hard part was never container-vs-VM but that eve
sessions own their sandbox, so attaching one to a run-owned resource
needs a custom provider either way. If eve-in-the-workspace is ever
wanted, it lands with that provider work (0004's sandbox-evolution
direction), not here.

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
| Stage × workspace | `harness` requires `workspace: project` (rejected at validation otherwise). `eve` always runs **with no sandbox** (amendment). `human` needs none. | Coding = harness; eve stages are for thinking, drafting, triage. |
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

## Eve stages (unsandboxed, per the amendment)

- A stage visit creates an ordinary eve session (`POST /eve/v1/session`)
  with `x-sweatshop-machine-run: <runId>:<seq>` lifted into principal
  attributes (like `project`), the brief as its first message, and
  `operationId` = the stage visit so a retried step finds the same
  session. No project binding → no sandbox, by construction.
- It is a real conversation: it shows in the sidebar, Chad can talk to
  it before it moves on.
- **Completion:** an eve tool `transition({ to, reason })`, offered only
  in machine sessions, records the proposal and resumes the stage's
  workflow hook (token = stage visit). Single-target stages get the same
  tool with one allowed value ("done"). The mirror hook stays model-free
  and passive.

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

1. **a ✅** Harness spike (above). (~~b~~ dropped by the amendment.)
2. Schema + zod definition validation + store + `/api/machines` CRUD +
   seed machines.
3. Engine: `runMachine` with harness and human stages, both workspace
   modes, bounds, transition tool, stage-hook routes.
4. Eve stages (unsandboxed sessions + `transition` tool).
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

1. ~~Single eve provider~~ — moot (amendment).
2. Run view location: `/r/<runId>` (decided at build time; one shape
   for project and non-project runs, like `/h`).

## Shipped (2026-10-09)

Commits `d062f7d` (spike) → the run_ticket port. Verified live on bee:

- **smoke** (pi → pi with a branch back): write → check → end in one
  container; files only in the container.
- **think** (eve → eve → human): draft → critique → decide (sent back
  with feedback) → critique applied it → decide → end. Single-target eve
  stages advanced themselves on `turn.completed`.
- **ticket** (the run_ticket port): plan (pi) → approve from the inbox
  card → implement (claude) → verify (pi) → publish (pi + create_pr)
  opened **sweatshop-e2e-scratch#32** (1 file, +1); container removed.
- **start_machine** from a Chats conversation started think and replied
  with `/r/<runId>`.

Findings that shaped the build:

- **Shared workdir:** without `sandboxConfig.workDir: "."`, a
  HarnessAgent puts each session in a private `<harness>-<sessionId>`
  directory, so stages can't see each other's files.
- **Run root:** pi runs in-process and checks whether the sandbox
  workdir also exists on the host. The dev runtime's `/workspace` is
  the repo bind mount, so pi would have read and written the host
  checkout. Run repos clone to `/work/<runId>` instead; the eve-session
  `pi` tool keeps `/workspace` (0005).
- **Bundler externals:** pi pulls `pi-mcp-adapter`, which exports raw
  `.ts`, so the harness packages are `serverExternalPackages`. The
  workflow body imports `@ai-sdk/workflow-harness` type-only.
- **Turn text:** the harness state doesn't carry the agent's text. The
  step reads text and the transition result from the UI chunk stream it
  forwards to the run's output stream.
- **ticket_runs dropped:** the table is gone (2 historical rows archived
  to `data/ticket_runs-archive-0009.json`), and `/t/<id>` redirects to
  `/machines`.
