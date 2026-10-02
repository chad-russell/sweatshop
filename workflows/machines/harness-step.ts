import type { HarnessWorkflowState } from "@ai-sdk/workflow-harness";
import type { MachineDefinition } from "@/lib/machines/definition";

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
  containerName: string;
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
    { attachSandbox },
    { toSandboxSession },
    { connectContainerToHarnessNetwork },
    { buildHarnessAgent, transitionTool },
    { recordHarnessEvent, clipHarnessText, claimHarnessRun },
    { openProjectPR },
    { tool },
    { z },
    { getWritable },
  ] = await Promise.all([
    import("@ai-sdk/workflow-harness"),
    import("@/lib/sandboxes/provision"),
    import("@/lib/sandboxes/ai-sdk-adapter"),
    import("@/lib/sandboxes/harness-bridge"),
    import("./harness-agent"),
    import("@/lib/harness-events"),
    import("@/lib/git-hosts/open-pr"),
    import("ai"),
    import("zod"),
    import("workflow"),
  ]);
  const { stageSessionId, runWorkspaceRoot } = await import("@/db/machines");

  const stage = input.definition.stages[input.stageId];
  if (!stage || stage.kind !== "harness") throw new Error(`stage ${input.stageId} is not a harness stage`);
  const sessionId = stageSessionId(input.runId, input.seq);
  const kind = stage.harness;
  const firstStep = input.state.status === "not_started";

  // Commands default to the run's workspace root: harnesses resolve
  // their sandbox home with `pwd`, and pi's in-process tools resolve
  // paths against that directory on the HOST too — so it must be a path
  // that does not exist in this runtime (a bare /workspace collides with
  // the dev container's repo mount, 0009 finding).
  const workDir = runWorkspaceRoot(input.runId);
  const sandbox = attachSandbox(input.containerName, workDir);
  const sandboxSession = toSandboxSession(sandbox, workDir);
  const bridgeIp =
    kind === "claude" ? (await connectContainerToHarnessNetwork(input.containerName)).ip : undefined;

  const projectId = input.projectId;
  const tools = {
    ...(stage.next.length > 1 ? { transition: transitionTool(stage) } : {}),
    create_pr: tool({
      description:
        "Open a pull request for a pushed branch of one of this project's repos " +
        "(repo = directory name under /workspace). Push the branch first.",
      inputSchema: z.object({
        repo: z.string(),
        head: z.string(),
        base: z.string().optional(),
        title: z.string().min(1),
        body: z.string().optional(),
      }),
      execute: async (args) => openProjectPR({ projectId, ...args }),
    }),
  };

  // /h/<harness>/<sessionId> needs a harness_runs row; claim on entry.
  if (firstStep) claimHarnessRun(sessionId, kind);
  if (firstStep) recordHarnessEvent(sessionId, kind, { kind: "start" });

  const agent = buildHarnessAgent({
    harness: kind,
    sessionId,
    bridgeIp,
    tools,
    model: stage.model,
    thinking: stage.thinking,
  });

  // Tee the UI chunks: forward to the run's output stream, mirror the
  // useful ones into harness_events, and watch for the transition result.
  const out = getWritable<Record<string, unknown>>();
  const writer = out.getWriter();
  let text = "";
  let proposed: string | null = null;
  const toolNames = new Map<string, string>();
  const sink = new WritableStream<Record<string, unknown>>({
    async write(chunk) {
      switch (chunk.type) {
        case "text-delta":
          text += String(chunk.delta ?? "");
          break;
        case "tool-input-available": {
          const name = String(chunk.toolName ?? "");
          toolNames.set(String(chunk.toolCallId), name);
          recordHarnessEvent(sessionId, kind, {
            kind: "tool-start",
            toolName: name,
            input: clipHarnessText(chunk.input, 1000),
          });
          break;
        }
        case "tool-output-available": {
          const name = toolNames.get(String(chunk.toolCallId)) ?? "tool";
          recordHarnessEvent(sessionId, kind, {
            kind: "tool-end",
            toolName: name,
            output: clipHarnessText(chunk.output, 2000),
          });
          const output = chunk.output as { ok?: unknown; to?: unknown } | undefined;
          if (name === "transition" && output?.ok === true && typeof output.to === "string") {
            proposed = output.to;
          }
          break;
        }
      }
      await writer.write({ ...chunk, machineRun: input.runId, machineSeq: input.seq });
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
      text: clipHarnessText(text, 500),
    });
    return {
      state: JSON.parse(JSON.stringify(next)) as HarnessWorkflowState,
      text,
      proposed,
    };
  } finally {
    writer.releaseLock();
  }
}
