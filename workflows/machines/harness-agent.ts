import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createPi } from "@ai-sdk/harness-pi";
import { isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { END, type Stage } from "@/lib/machines/definition";

/**
 * 0009: build the HarnessAgent for one harness stage visit. Called fresh
 * inside every workflow step (Node-only; never imported by the workflow
 * body). `stopWhen: isStepCount(1)` makes one `stream()` = one agent
 * step — the semantic-step durability grain the doc decided.
 */

const PI_DEFAULT_MODEL = process.env.PI_MODEL ?? "zai-glm/glm-5.3-flash";

export type HarnessStage = Extract<Stage, { kind: "harness" }>;

export interface BuildArgs {
  stage: HarnessStage;
  /** Stage-visit harness session id (`mr_<run>_<seq>`). */
  sessionId: string;
  /** Bridge endpoint IP on the harness network (claude only). */
  bridgeIp?: string;
  /** Host tools for this stage (transition, create_pr, …). */
  tools: ToolSet;
}

export function buildHarnessAgent({ stage, sessionId, bridgeIp, tools }: BuildArgs) {
  if (stage.harness === "pi") {
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
        thinkingLevel: stage.thinking ?? "low",
      }),
      id: `pi-${sessionId}`,
      model: stage.model ?? PI_DEFAULT_MODEL,
      // Without a workDir the harness gives every session a private
      // `<harness>-<sessionId>` directory — stages would not see each
      // other's work. "." = the sandbox cwd, the run's workspace root.
      sandboxConfig: { workDir: "." },
      tools,
      stopWhen: isStepCount(1),
    });
  }
  if (!bridgeIp) throw new Error("claude requires a resolved bridge endpoint");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    throw new Error("claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)");
  }
  return new HarnessAgent({
    // 0006 amendment: setup-token through the env channel, direct route.
    harness: createClaudeCode({
      auth: "direct",
      port: 4000,
      portEndpoint: { url: `ws://${bridgeIp}:4000` },
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    }),
    id: `claude-${sessionId}`,
    ...(stage.model ? { model: stage.model } : {}),
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
