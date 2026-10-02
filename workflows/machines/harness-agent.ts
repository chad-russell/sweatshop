import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createPi } from "@ai-sdk/harness-pi";
import { isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { END, type Stage } from "@/lib/machines/definition";
import { HARNESS_BRIDGE_PORT } from "@/lib/sandboxes/harness-bridge";

/**
 * 0009: build the HarnessAgent for one harness stage visit. Called fresh
 * inside every workflow step (Node-only; never imported by the workflow
 * body). `stopWhen: isStepCount(1)` makes one `stream()` = one agent
 * step — the semantic-step durability grain the doc decided.
 */

const PI_DEFAULT_MODEL = process.env.PI_MODEL ?? "zai-glm/glm-5.3-flash";

export type HarnessStage = Extract<Stage, { kind: "harness" }>;

export interface BuildArgs {
  /** Which harness to build ("pi" | "claude"). */
  harness: "pi" | "claude";
  /** Harness session id (0010 chat: the conversation id). */
  sessionId: string;
  /** Host tools (transition, create_pr, …). */
  tools: ToolSet;
  model?: string;
  /** pi thinking level. */
  thinking?: "off" | "low" | "medium" | "high";
}

export function buildHarnessAgent({ harness, sessionId, tools, model, thinking }: BuildArgs) {
  if (harness === "pi") {
    return new HarnessAgent({
      harness: createPi({
        providers: {
          "zai-glm": {
            name: "Z.AI GLM Coding Plan",
            baseUrl: "https://api.z.ai/api/anthropic",
            apiKey: process.env.ZAI_API_KEY ?? "",
            api: "anthropic",
          },
        },
        thinkingLevel: thinking ?? "low",
      }),
      id: `pi-${sessionId}`,
      model: model ?? PI_DEFAULT_MODEL,
      // Without a workDir the harness gives every session a private
      // `<harness>-<sessionId>` directory — stages would not see each
      // other's work. "." = the sandbox cwd, the run's workspace root.
      sandboxConfig: { workDir: "." },
      tools,
      stopWhen: isStepCount(1),
    });
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    throw new Error("claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)");
  }
  return new HarnessAgent({
    // 0006 amendment: setup-token through the env channel, direct route.
    // The bridge endpoint comes from the network sandbox session's
    // getPortEndpoint (0013) — joined to the harness network on demand.
    harness: createClaudeCode({
      auth: "direct",
      port: HARNESS_BRIDGE_PORT,
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    }),
    id: `claude-${sessionId}`,
    ...(model ? { model } : {}),
    // "." = the sandbox cwd, the run's workspace root (shared by stages).
    sandboxConfig: { workDir: "." },
    tools,
    stopWhen: isStepCount(1),
  });
}

/**
 * The side-effect-free transition tool (0009): only offered when the
 * stage branches; its enum is exactly the allowed targets. The engine
 * reads the proposal from the tool result and the interpreter commits.
 */
export function transitionTool(stage: Stage) {
  const targets = stage.next.map((t) => t.to);
  return tool({
    description:
      "Finish this stage and choose where the run goes next. Call exactly once, " +
      "when your work for the stage is complete. Targets: " +
      stage.next.map((t) => `${t.to}${t.when ? ` (${t.when})` : ""}`).join("; "),
    inputSchema: z.object({
      to: z.enum(targets as [string, ...string[]]),
      reason: z.string().max(2000).describe("One or two sentences: why this target"),
    }),
    execute: async ({ to }) => ({ ok: true as const, to, note: to === END ? "run will end" : `next stage: ${to}` }),
  });
}
