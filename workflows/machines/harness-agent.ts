import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createPi } from "@ai-sdk/harness-pi";
import { isStepCount, tool, type ToolSet } from "ai";
import { z } from "zod";
import { END, type Stage } from "@/lib/machines/definition";
import type { ModelInfo } from "@/lib/providers/catalog";
import { piProviderConfig } from "@/lib/providers/registry";
import type { HarnessRoute } from "@/lib/providers/route";
import { HARNESS_BRIDGE_PORT } from "@/lib/sandboxes/harness-bridge";

/**
 * 0009: build the HarnessAgent for one harness stage visit. Called fresh
 * inside every workflow step (Node-only; never imported by the workflow
 * body). `stopWhen: isStepCount(1)` makes one `stream()` = one agent
 * step — the semantic-step durability grain the doc decided.
 */

export type HarnessStage = Extract<Stage, { kind: "harness" }>;

export interface BuildArgs {
  /** 0021: the resolved, validated route — decides harness, provider, model. */
  route: HarnessRoute;
  /** Harness session id (0010 chat: the conversation id). */
  sessionId: string;
  /** Host tools (transition, create_pr, …). */
  tools: ToolSet;
  /** pi model sizing, when the caller knows it (catalog entry). */
  modelInfo?: ModelInfo;
}

/** pi provider ids are namespaced so they never collide with pi's built-ins. */
const PI_PROVIDER_PREFIX = "ss-";

export function buildHarnessAgent({ route, sessionId, tools, modelInfo }: BuildArgs) {
  if (route.harness === "pi") {
    // 0021: only the route's provider is registered, with the model
    // declared explicitly — pi never needs its built-in catalog to know
    // a Gloo or OpenRouter id.
    const piProvider = `${PI_PROVIDER_PREFIX}${route.provider}`;
    return new HarnessAgent({
      harness: createPi({
        providers: { [piProvider]: piProviderConfig(route.provider, route.model, modelInfo) as never },
        thinkingLevel: route.thinking ?? "low",
        // No Gloo tool-description fix needed here: harness-pi already
        // gives every host tool a description (verified live, 2026-10-08 —
        // pi on Gloo with an undescribed host tool round-trips).
      }),
      id: `pi-${sessionId}`,
      model: `${piProvider}/${route.model}`,
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
    // 0021: subscription only — the route contributes model/effort, never
    // an endpoint.
    harness: createClaudeCode({
      auth: "direct",
      port: HARNESS_BRIDGE_PORT,
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      ...(route.effort ? { effort: route.effort } : {}),
    }),
    id: `claude-${sessionId}`,
    ...(route.model ? { model: route.model } : {}),
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

/**
 * The create_pr host tool every harness surface offers (0004 D; 0031:
 * shared by the chat harness step and machine harness stages — one
 * definition instead of two verbatim copies).
 */
export function createPrTool(projectId: string) {
  return tool({
    description:
      "Open a pull request for a pushed branch of one of this project's repos " +
      "(repo = directory name under the work root). Push the branch first.",
    inputSchema: z.object({
      repo: z.string(),
      head: z.string(),
      base: z.string().optional(),
      title: z.string().min(1),
      body: z.string().optional(),
    }),
    execute: async (args: {
      repo: string;
      head: string;
      base?: string;
      title: string;
      body?: string;
    }) => {
      const { openProjectPR } = await import("@/lib/git-hosts/open-pr");
      return openProjectPR({ projectId, ...args });
    },
  });
}
