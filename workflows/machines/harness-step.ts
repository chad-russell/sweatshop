import { HARNESS_INPUT_CLIP, HARNESS_OUTPUT_CLIP } from "@/lib/harness-limits";
import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { MachineDefinition } from "@/lib/machines/definition";
import type { BoundSandbox } from "@/db/sandboxes";
import type { HarnessRoute } from "@/lib/providers/route";
import { harnessEventSink } from "../shared/harness-sink";

/**
 * 0009: the ONE workflow step a harness stage repeats — rebuild the
 * stage's HarnessAgent against the run's container and advance the turn
 * by one semantic agent step (`runHarnessAgentStep`). Its own module so
 * the agent, sandbox, and sqlite stay out of the workflow bundle; every
 * Node import happens inside the step.
 *
 * Only JSON crosses the boundary: the HarnessWorkflowState plus what the
 * step observed in the UI chunk stream (assistant text and the
 * transition proposal), since the harness state does not carry either.
 */

export interface HarnessStepInput {
  runId: string;
  seq: number;
  stageId: string;
  definition: MachineDefinition;
  projectId: string;
  /** 0013: the run's binding (own or inherited). */
  binding: BoundSandbox;
  /** 0021: the visit's resolved, validated route. */
  route: HarnessRoute;
  state: HarnessWorkflowState;
}

export interface HarnessStepResult {
  state: HarnessWorkflowState;
  /** Assistant text emitted during this step (all text parts, joined). */
  text: string;
  /** A successful transition proposal seen this step, if any. */
  proposed: string | null;
}

export async function harnessStep(input: HarnessStepInput): Promise<HarnessStepResult> {
  "use step";
  const [
    { runHarnessAgentStep },
    { openSandbox },
    { toNetworkSandboxSession },
    { buildHarnessAgent, transitionTool, createPrTool },
    { recordHarnessEvent, clipHarnessText, claimHarnessRun },
    { getWritable },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("@/lib/sandboxes/binding"),
    import("@/lib/sandboxes/ai-sdk-adapter"),
    import("./harness-agent"),
    import("@/lib/harness-events"),
    import("workflow"),
  ]);
  const [{ stageSessionId }, { db }, { getModelInfo }] = await Promise.all([
    import("@/db/machines"),
    import("@/db"),
    import("@/db/providers"),
  ]);

  const stage = input.definition.stages[input.stageId];
  if (!stage || stage.kind !== "harness") throw new Error(`stage ${input.stageId} is not a harness stage`);
  const sessionId = stageSessionId(input.runId, input.seq);
  const kind = stage.harness;
  const firstStep = input.state.status === "not_started";

  // Commands default to the binding's workDir: harnesses resolve their
  // sandbox home from it, and pi's in-process tools resolve paths
  // against it on the HOST too — so it is always a /work/<owner> path,
  // never one that exists in this runtime (0009 finding).
  const { sandboxId, workDir, handle } = await openSandbox(input.binding);
  const sandboxSession = toNetworkSandboxSession({ id: sandboxId, handle, workDir });

  const projectId = input.projectId;
  const tools = {
    ...(stage.next.length > 1 ? { transition: transitionTool(stage) } : {}),
    create_pr: createPrTool(projectId),
  };

  // /h/<harness>/<sessionId> needs a harness_runs row; claim on entry.
  if (firstStep) claimHarnessRun(sessionId, kind);
  if (firstStep) recordHarnessEvent(sessionId, kind, { kind: "start" });

  const route = input.route;
  const agent = buildHarnessAgent({
    route,
    sessionId,
    tools,
    ...(route.harness === "pi" ? { modelInfo: getModelInfo(db(), route.provider, route.model) } : {}),
  });

  // Tee the UI chunks through the shared harness sink (0031): events
  // into harness_events, the chunks to the run's output stream, and
  // the transition proposal watched from tool results.
  const out = getWritable<Record<string, unknown>>();
  const writer = out.getWriter();
  let proposed: string | null = null;
  const { sink, text } = harnessEventSink({
    recordEvent: (event) => recordHarnessEvent(sessionId, kind, event),
    clip: clipHarnessText,
    inputClip: HARNESS_INPUT_CLIP,
    outputClip: HARNESS_OUTPUT_CLIP,
    writer,
    envelope: { machineRun: input.runId, machineSeq: input.seq },
    onToolResult: (name, output) => {
      const result = output as { ok?: unknown; to?: unknown } | undefined;
      if (name === "transition" && result?.ok === true && typeof result.to === "string") {
        proposed = result.to;
      }
    },
  });

  try {
    const next = await runHarnessAgentStep({
      agent: agent as never,
      state: input.state,
      sandboxSession: sandboxSession as never,
      writable: sink as never,
    });
    recordHarnessEvent(sessionId, kind, {
      kind: "step-end",
      text: clipHarnessText(text(), 500),
    });
    return {
      state: JSON.parse(JSON.stringify(next)) as HarnessWorkflowState,
      text: text(),
      proposed,
    };
  } finally {
    writer.releaseLock();
  }
}
