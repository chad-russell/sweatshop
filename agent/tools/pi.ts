import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Experimental_SandboxSession } from "ai";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createPi } from "@ai-sdk/harness-pi";
import {
  clipHarnessText,
  getActiveHarnessRun,
  recordHarnessEvent,
  recordHarnessRunEnd,
  recordHarnessRunStart,
} from "../../lib/harness-events";
import { toSandboxSession } from "../../lib/sandboxes/ai-sdk-adapter";

/**
 * 0005: the pi coding harness, attached to THIS conversation's project
 * sandbox. pi runs in-process and uses the sandbox as its remote
 * filesystem + shell (no bridge inside the container), on GLM via the
 * Z.AI coding plan's Anthropic Messages surface. Requires a project
 * conversation — the sandbox is the workspace.
 *
 * One harness session per conversation (module cache; lives while the
 * dev server lives). pi keeps its own turn history, so successive calls
 * continue one coding session.
 */

const PI_MODEL = process.env.PI_MODEL ?? "zai-glm/glm-5.3-flash";

interface CachedHarness {
  agent: HarnessAgent;
  session: Awaited<ReturnType<HarnessAgent["createSession"]>>;
}

const harnessCache = new Map<string, CachedHarness>();

async function getHarness(
  sessionId: string,
  sandboxSession: Experimental_SandboxSession,
): Promise<CachedHarness> {
  const cached = harnessCache.get(sessionId);
  if (cached) return cached;

  const pi = createPi({
    providers: {
      "zai-glm": {
        name: "Z.AI GLM Coding Plan",
        baseUrl: "https://api.z.ai/api/anthropic",
        apiKey: process.env.ZAI_API_KEY ?? "",
        api: "anthropic",
      },
    },
    thinkingLevel: "low",
  });
  const agent = new HarnessAgent({ harness: pi, id: `pi-${sessionId}`, model: PI_MODEL });
  const session = await agent.createSession({ sandboxSession });
  harnessCache.set(sessionId, { agent, session });
  return { agent, session };
}

export default defineTool({
  description:
    "Hand a coding task to the pi harness, which works in this " +
    "conversation's sandbox (repos under /workspace) with its own " +
    "read/write/edit/bash tools and keeps context across calls. Use for " +
    "non-trivial code changes; use plain bash for quick commands. The " +
    "repo state is shared — pi's edits are immediately visible to bash.",
  inputSchema: z.object({
    task: z.string().min(1).describe("The coding task, with enough context to act on."),
  }),
  async execute({ task }, ctx) {
    const attributes = ctx.session.auth.initiator?.attributes as
      | { project?: unknown }
      | undefined;
    if (typeof attributes?.project !== "string") {
      throw new Error(
        "pi requires a project conversation — start one from a project page",
      );
    }

    // v1 concurrency contract: one harness at a time per sandbox (0006).
    const active = getActiveHarnessRun(ctx.session.id);
    if (active) {
      throw new Error(
        `a ${active.kind} harness run is already active in this conversation — ` +
          "wait for it to finish before starting pi",
      );
    }

    const eveSandbox = await ctx.getSandbox();
    // Bridge eve's session sandbox to the AI SDK session shape.
    const sandboxSession = toSandboxSession({
      run: (command, env, workingDirectory) =>
        eveSandbox.run({
          command,
          ...(env ? { env } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        }),
    });

    const { agent, session } = await getHarness(ctx.session.id, sandboxSession);

    // Full harness event stream (0005 visibility, 0006 multi-harness):
    // every model step and tool call is recorded per conversation ×
    // harness into sqlite and served at /h/<sessionId> (raw JSON:
    // /api/harness/<sessionId>?harness=pi).
    recordHarnessRunStart(ctx.session.id, "pi");
    let toolCalls = 0;
    let failure: string | undefined;
    try {
      const result = await agent.generate({
        session,
        prompt: task,
        onStart: () => recordHarnessEvent(ctx.session.id, "pi", { kind: "start" }),
        onStepStart: () =>
          recordHarnessEvent(ctx.session.id, "pi", { kind: "step-start" }),
        onStepEnd: ({ text }) =>
          recordHarnessEvent(ctx.session.id, "pi", {
            kind: "step-end",
            text: clipHarnessText(text, 500),
          }),
        onToolExecutionStart: ({ toolCall }) => {
          toolCalls += 1;
          recordHarnessEvent(ctx.session.id, "pi", {
            kind: "tool-start",
            toolName: toolCall.toolName,
            input: clipHarnessText(toolCall.input, 1000),
          });
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) =>
          recordHarnessEvent(ctx.session.id, "pi", {
            kind: "tool-end",
            toolName: toolCall.toolName,
            output: clipHarnessText(
              "output" in (toolOutput ?? {})
                ? (toolOutput as { output?: unknown }).output
                : toolOutput,
              2000,
            ),
          }),
        onEnd: () => recordHarnessEvent(ctx.session.id, "pi", { kind: "end" }),
      });
      return {
        text: result.text,
        toolCalls,
        harnessUrl: `/h/${ctx.session.id}`,
        eventLogUrl: `/api/harness/${ctx.session.id}?harness=pi`,
        note: "pi session continues across calls in this conversation.",
      };
    } catch (err) {
      // 0006: failures are failures — keep the transcript, record why.
      failure = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      recordHarnessRunEnd(
        ctx.session.id,
        "pi",
        toolCalls,
        failure ? "failed" : "completed",
        failure,
      );
    }
  },
});
