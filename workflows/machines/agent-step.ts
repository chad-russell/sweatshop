import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import type { ToolSet } from "ai";
import type { MachineDefinition, Stage } from "@/lib/machines/definition";
import type { BoundSandbox } from "@/db/sandboxes";
import type { ChatRoute } from "@/lib/providers/route";

/**
 * 0010 Phase 5: one agent-stage visit — an in-process WorkflowAgent turn
 * (replacing the 0009 `eve` stage, which crossed processes via HTTP and
 * the mirror's turn-end nudge). The whole visit is ONE workflow step:
 * crash recovery re-executes the visit from the brief (the harness
 * stages keep their finer semantic-step grain; agent stages are single
 * turns by design).
 *
 * The visit is a conversation (persisted through the chat steps under
 * the stage's session id), so it shows in the sidebar/inbox exactly as
 * the old eve stage sessions did. Branching stages get a side-effect-
 * free `transition` tool (0009's pattern — the interpreter validates and
 * commits the proposal); single-target stages advance on completion.
 *
 * 0013: in a project run the stage inherits the run's sandbox binding and
 * gets bash / pi / claude in it (same sandbox, same directory as every
 * other stage). Tool executes call the plain cores directly — the whole
 * visit is already one step.
 */

export interface AgentStageInput {
  runId: string;
  seq: number;
  definition: MachineDefinition;
  stageId: string;
  brief: string;
  /** 0021: the visit's resolved, validated route. */
  route: ChatRoute;
  /** 0013: the run's binding (project runs); null = no sandbox tools. */
  binding?: BoundSandbox | null;
  projectId?: string | null;
}

export interface AgentStageResult {
  text: string;
  proposed: string | null;
}

export async function agentStageStep(input: AgentStageInput): Promise<AgentStageResult> {
  "use step";
  const { runId, seq, brief } = input;
  const [
    { WorkflowAgent },
    { getWritable },
    { tool },
    { z },
    { chatLanguageModel },
    { db },
    { ensureConversation },
    chatSteps,
    { stageSessionId },
    { END },
  ] = await Promise.all([
    import("@ai-sdk/workflow"),
    import("workflow"),
    import("ai"),
    import("zod"),
    import("../../lib/providers/registry"),
    import("../../db"),
    import("../../db/chat"),
    import("../chat/steps"),
    import("../../db/machines"),
    import("../../lib/machines/definition"),
  ]);

  const stage: Stage | undefined = input.definition.stages[input.stageId];
  if (!stage || stage.kind !== "agent") {
    throw new Error(`stage ${input.stageId} is not an agent stage`);
  }
  const sessionId = stageSessionId(runId, seq);
  const targets: string[] = stage.next.map((t) => t.to);

  // The conversation the sidebar/inbox see (one per visit, like the old
  // eve stage sessions) — also the /r view's "open conversation" link.
  ensureConversation(db(), sessionId, null, "stage");
  const { updateStageRun } = await import("../../db/machines");
  updateStageRun(db(), runId, seq, { sessionId, status: "running" });

  const tools: ToolSet = {
    ...(input.binding && input.projectId
      ? await stageSandboxTools(sessionId, input.binding, input.projectId)
      : {}),
    ...(targets.length > 1
      ? {
          transition: tool({
            description:
              "Finish this stage and choose where the run goes next. Call exactly once, " +
              "when your work for the stage is complete. Targets: " +
              stage.next.map((t) => `${t.to}${t.when ? ` (${t.when})` : ""}`).join("; "),
            inputSchema: z.object({
              to: z.enum(targets as [string, ...string[]]),
              reason: z.string().max(2000).describe("One or two sentences: why this target"),
            }),
            execute: async ({ to }) => ({
              ok: true as const,
              to,
              note: to === END ? "run will end" : `next stage: ${to}`,
            }),
          }),
        }
      : {}),
  };

  // Tee the turn into the run's output stream (the /r view shows agent
  // stages live) and watch for the transition proposal.
  const out = getWritable<Record<string, unknown>>();
  const writer = out.getWriter();
  let proposed: string | null = null;
  let text = "";
  const toolNames = new Map<string, string>();
  const sink = new WritableStream<Record<string, unknown>>({
    async write(chunk) {
      switch (chunk.type) {
        case "text-delta":
          text += String(chunk.delta ?? "");
          break;
        case "tool-input-available": {
          toolNames.set(String(chunk.toolCallId), String(chunk.toolName ?? ""));
          break;
        }
        case "tool-output-available": {
          const name = toolNames.get(String(chunk.toolCallId)) ?? "tool";
          const output = chunk.output as { ok?: unknown; to?: unknown } | undefined;
          if (name === "transition" && output?.ok === true && typeof output.to === "string") {
            proposed = output.to;
          }
          break;
        }
      }
      await writer.write({ ...chunk, machineRun: runId, machineSeq: seq });
    },
  });

  const model = chatLanguageModel(input.route.provider, input.route.model);
  const agent = new WorkflowAgent({
    model,
    instructions: "You are a stage of a machine run. Follow the brief exactly.",
    tools,
  });

  try {
    await chatSteps.recordUserMessage(sessionId, brief, 0);
    const result = await agent.stream({
      messages: [{ role: "user", content: brief }],
      writable: sink as unknown as WritableStream<ModelCallStreamPart>,
    });
    // Persist the visit conversation (outcome = final assistant text).
    const lastAssistant = [...result.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const outcomeText =
      text.trim() ||
      (Array.isArray(lastAssistant?.content)
        ? lastAssistant.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")
            .trim()
        : "") ||
      "";
    // result.messages leads with the system prompt; skip it plus the
    // brief (already recorded above) so only the new tail is stored.
    const system = result.messages.findIndex((m) => m.role !== "system");
    await chatSteps.persistTurn(sessionId, result.messages, Math.max(system, 0) + 1);
    return { text: outcomeText, proposed };
  } finally {
    writer.releaseLock();
  }
}

/** 0013: bash / pi / claude (+ 0016 previews) for an agent stage, in the run's binding. */
async function stageSandboxTools(
  sessionId: string,
  binding: BoundSandbox,
  projectId: string,
): Promise<ToolSet> {
  const [{ tool }, { z }, { runBashIn }, { harnessToolStep }, { previewTools }, previews] = await Promise.all([
    import("ai"),
    import("zod"),
    import("../../lib/agent/tools/bash"),
    import("../chat/harness-step"),
    import("../chat/preview-tools"),
    import("../../lib/agent/tools/previews"),
  ]);
  // 0016: previews in the run's sandbox. This whole function runs inside
  // the stage's one step, so the cores are called directly.
  const caller = { kind: "inherited" as const, sessionId, binding, projectId };
  const harness = (kind: "pi" | "claude") =>
    tool({
      description:
        kind === "pi"
          ? "Hand a coding task to the pi harness, working in this run's sandbox (repos under " +
            `${binding.workDir}). Keeps context across calls in this stage.`
          : "Hand a coding task to the Claude Code harness, working in this run's sandbox " +
            `(repos under ${binding.workDir}). Keeps context across calls in this stage.`,
      inputSchema: z.object({
        task: z.string().min(1).describe("The coding task, with enough context to act on."),
      }),
      execute: ({ task }) =>
        harnessToolStep({
          conversationId: sessionId,
          kind,
          task,
          inherited: { binding, projectId },
        }),
    });
  return {
    bash: tool({
      description:
        `Run a bash command in this run's sandbox, in ${binding.workDir} — the same checkout ` +
        "every stage of the run works in.",
      inputSchema: z.object({ command: z.string().max(20_000).describe("The bash command to run.") }),
      execute: ({ command }) => runBashIn(sessionId, binding, command),
    }),
    ...previewTools((action, input) =>
      action === "start"
        ? previews.startPreviewTool(caller, input)
        : action === "status"
          ? previews.previewStatusTool(caller, input)
          : action === "get-setup"
            ? previews.getPreviewSetupTool(caller)
            : action === "save-setup"
              ? previews.savePreviewSetupTool(caller, input as { definition: unknown })
              : previews.stopPreviewTool(caller, input as { id: string }),
    ),
    pi: harness("pi"),
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { claude: harness("claude") } : {}),
  };
}
