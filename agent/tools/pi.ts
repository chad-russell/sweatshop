import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Experimental_SandboxSession } from "ai";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createPi } from "@ai-sdk/harness-pi";
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

    const eveSandbox = await ctx.getSandbox();
    // Bridge eve's session sandbox to the AI SDK session shape.
    const sandboxSession = toSandboxSession({
      run: (command, env) =>
        eveSandbox.run({
          command,
          ...(env ? { env } : {}),
        }),
    });

    const { agent, session } = await getHarness(ctx.session.id, sandboxSession);
    const result = await agent.generate({ session, prompt: task });
    return {
      text: result.text,
      note: "pi session continues across calls in this conversation.",
    };
  },
});
