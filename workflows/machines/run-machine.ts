import { defineHook } from "workflow";
import { z } from "zod";
// Type-only: a runtime import would drag the harness stack (pi →
// pi-mcp-adapter .ts sources) into the workflow bundle and break it.
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
// Type-only (db/sandboxes is Node; the binding itself is plain data).
import type { BoundSandbox } from "@/db/sandboxes";
import {
  DEFAULT_MAX_VISITS,
  END,
  MAX_HARNESS_STEPS,
  type MachineDefinition,
} from "@/lib/machines/definition";
import { buildBrief, resolveTransition, type PriorVisit, type ProjectFacts } from "@/lib/machines/brief";
import { agentStageStep } from "./agent-step";
import { harnessStep } from "./harness-step";
import {
  beginVisit,
  endHarnessSession,
  endVisit,
  loadHistory,
  loadEvidence,
  markRun,
  provisionWorkspace,
  publishStep,
  recordSteps,
  resolveVisitRoute,
} from "./steps";
import type { ChatRoute, HarnessRoute } from "@/lib/providers/route";

/**
 * 0009 runMachine — the interpreter and single writer of a run. Pure
 * orchestration (the workflow transform forbids Node here): every side
 * effect is a step in ./steps or ./harness-step.
 *
 *   project workspace → the run's sandbox binding (0013): inherited
 *   from the starting chat, or one sandbox provisioned here; every
 *   harness and agent stage runs in it. The sandbox outlives the run so
 *   finished work can be inspected or attached to: an owned one is
 *   reaped on the run windows (sandbox-gc) or destroyed when the run is
 *   purged; an inherited one belongs to its owner and is never touched.
 *   harness → harnessStep() per semantic agent step until the turn ends
 *   eve     → start an unsandboxed session, suspend on its stage hook
 *             until its `transition` tool resumes it
 *   human   → suspend on the gate hook until Chad answers (/inbox)
 *   then resolve + commit the transition; END completes the run.
 *
 * Hook tokens are the stage-visit token `<runId>:<seq>`.
 */

/** Chad's answer at a human stage: where to go (+ optional feedback). */
export const gateHook = defineHook({
  schema: z.object({
    to: z.string(),
    comment: z.string().max(10_000).optional(),
  }),
});

export interface RunMachineInput {
  runId: string;
  definition: MachineDefinition;
  prompt: string;
  projectId: string | null;
  /** 0013: an inherited binding (the starting chat's); null = provision
   *  the run's own sandbox at start (project machines). */
  binding?: BoundSandbox | null;
  /** 0023: the project's work defaults for briefs ("# Project");
   *  null = no project / none set. Plain data, fetched in startRun. */
  project?: ProjectFacts | null;
}

type VisitOutcome =
  | { ok: true; outcome: string; proposed: string | null; feedback?: string }
  | { ok: false; parked: string };

export async function runMachine(input: RunMachineInput) {
  "use workflow";
  const { runId, definition, prompt } = input;
  let binding: BoundSandbox | null = input.binding ?? null;
  try {
    if (definition.workspace === "project" && !binding) {
      if (!input.projectId) throw new Error("project machine run without a project");
      binding = await provisionWorkspace(runId, input.projectId);
    }

    const visits = new Map<string, number>();
    let feedback: string | null = null;
    let at: string = definition.start;
    for (let seq = 0; ; seq += 1) {
      const stage = definition.stages[at]!;
      const count = (visits.get(at) ?? 0) + 1;
      visits.set(at, count);
      if (count > (stage.maxVisits ?? DEFAULT_MAX_VISITS)) {
        await markRun(runId, {
          status: "needs-attention",
          error: `stage "${at}" exceeded its visit bound (${stage.maxVisits ?? DEFAULT_MAX_VISITS})`,
        });
        return { status: "needs-attention" as const };
      }

      await beginVisit({
        runId,
        seq,
        stageId: at,
        kind: stage.kind,
        harness: stage.kind === "harness" ? stage.harness : null,
      });
      const history = await loadHistory(runId);
      const evidence = await loadEvidence(runId);
      const prior: PriorVisit[] = history
        .filter((v) => v.seq < seq)
        .map((v) => ({
          stageId: v.stageId,
          title: definition.stages[v.stageId]?.title ?? v.stageId,
          outcome: v.outcome,
          transitionTo: v.transitionTo,
          ...(evidence[v.seq]?.length ? { evidence: evidence[v.seq] } : {}),
        }));
      const brief = buildBrief({
        prompt,
        definition,
        stageId: at,
        history: prior,
        feedback,
        workspaceRoot: binding?.workDir ?? null,
        project: input.project ?? null,
      });
      feedback = null;
      const token = `${runId}:${seq}`;

      let result!: VisitOutcome;
      if (stage.kind === "harness") {
        result = await runHarnessVisit({
          runId,
          seq,
          stageId: at,
          definition,
          projectId: input.projectId!,
          binding: binding!,
          brief,
          harness: stage.harness,
        });
      } else if (stage.kind === "agent") {
        // 0010 Phase 5: the visit is an in-process WorkflowAgent turn —
        // no session creation, no hook, no turn-end nudge.
        // 0021: a route that cannot run (missing key, project
        // restriction) parks the run with the reason, like a harness
        // stage's failure — retrying with the same config cannot help.
        let route: ChatRoute | null = null;
        try {
          route = (await resolveVisitRoute({ runId, seq, stageId: at, surface: "agent" })).route as ChatRoute;
        } catch (err) {
          result = { ok: false, parked: `route error: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (route) {
          const visit = await agentStageStep({
            runId,
            seq,
            definition,
            stageId: at,
            route,
            brief,
            binding,
            projectId: input.projectId,
          });
          result = { ok: true, outcome: visit.text, proposed: visit.proposed };
        }
      } else if (stage.kind === "publish") {
        // 0034 A: deterministic — the human gate upstream approved the
        // run's PR proposal; this pushes the branch and opens it.
        if (!binding) {
          result = { ok: false, parked: "publish stage without a project workspace (no sandbox to push from)" };
        } else {
          result = await publishStep({ runId, binding });
        }
      } else {
        using hook = gateHook.create({ token });
        const answer = await hook;
        result = { ok: true, outcome: answer.comment ?? "", proposed: answer.to, feedback: answer.comment };
      }

      if (!result.ok) {
        await endVisit({ runId, seq, status: "parked", error: result.parked });
        await markRun(runId, { status: "needs-attention", error: result.parked });
        return { status: "needs-attention" as const };
      }

      // The transition is resolved from the visit's own result — no
      // post-visit loading (the agent stage returns its outcome).
      const outcome = result.outcome;
      const next = resolveTransition(stage, result.proposed);
      if (next === null) {
        const why = `stage "${at}" finished without choosing a valid next stage`;
        await endVisit({ runId, seq, status: "parked", outcome, error: why });
        await markRun(runId, { status: "needs-attention", error: why });
        return { status: "needs-attention" as const };
      }
      await endVisit({ runId, seq, status: "completed", outcome, transitionTo: next });
      if (result.feedback) feedback = result.feedback;
      if (next === END) {
        await markRun(runId, { status: "completed", currentStage: null, error: null });
        return { status: "completed" as const };
      }
      at = next;
    }
  } catch (err) {
    await markRun(runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** One harness stage visit: semantic agent steps until the turn ends. */
async function runHarnessVisit(input: {
  runId: string;
  seq: number;
  stageId: string;
  definition: MachineDefinition;
  projectId: string;
  binding: BoundSandbox;
  brief: string;
  harness: "pi" | "claude";
}): Promise<VisitOutcome> {
  const sessionId = `${input.runId}_${input.seq}`;
  // = createHarnessWorkflowState({ sessionId, prompt }) — built inline
  // to keep the workflow bundle free of runtime harness imports.
  let state: HarnessWorkflowState = { sessionId, prompt: input.brief, status: "not_started" };
  let text = "";
  let lastText = "";
  let proposed: string | null = null;
  let steps = 0;
  try {
    // 0021: resolved once per visit (every semantic step reuses it).
    const { route } = await resolveVisitRoute({
      runId: input.runId,
      seq: input.seq,
      stageId: input.stageId,
      surface: input.harness,
    });
    do {
      const r = await harnessStep({
        runId: input.runId,
        seq: input.seq,
        stageId: input.stageId,
        definition: input.definition,
        projectId: input.projectId,
        binding: input.binding,
        route: route as HarnessRoute,
        state,
      });
      state = r.state;
      steps += 1;
      if (r.text.trim()) {
        lastText = r.text;
        text += (text ? "\n\n" : "") + r.text;
      }
      if (r.proposed) proposed = r.proposed;
      if (steps % 10 === 0) await recordSteps(input.runId, input.seq, steps);
    } while (state.status === "ready_for_next_step" && steps < MAX_HARNESS_STEPS);
  } catch (err) {
    const message = `harness error: ${err instanceof Error ? err.message : String(err)}`;
    await endHarnessSession({ runId: input.runId, seq: input.seq, harness: input.harness, status: "failed", error: message });
    return { ok: false, parked: message };
  }
  await recordSteps(input.runId, input.seq, steps);

  if (state.status === "ready_for_next_step") {
    await endHarnessSession({ runId: input.runId, seq: input.seq, harness: input.harness, status: "failed", error: "step budget exhausted" });
    return { ok: false, parked: `harness stage exceeded ${MAX_HARNESS_STEPS} agent steps` };
  }
  if (state.status === "failed") {
    const message = `harness failed: ${state.error ?? "unknown error"}`;
    await endHarnessSession({ runId: input.runId, seq: input.seq, harness: input.harness, status: "failed", error: message });
    return { ok: false, parked: message };
  }
  if (state.status === "awaiting_tool_approval") {
    // v1 host tools declare no approvals; reaching here is a bug.
    await endHarnessSession({ runId: input.runId, seq: input.seq, harness: input.harness, status: "failed", error: "unexpected approval request" });
    return { ok: false, parked: "harness requested a tool approval (unsupported in v1)" };
  }
  await endHarnessSession({ runId: input.runId, seq: input.seq, harness: input.harness, status: "completed" });
  // The stage's outcome is its final reply; keep the whole transcript
  // only when the last step said nothing.
  return { ok: true, outcome: lastText || text, proposed };
}
