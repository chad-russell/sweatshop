import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createPi } from "@ai-sdk/harness-pi";
import { isStepCount, type ToolSet } from "ai";
import type { ModelInfo } from "@/lib/providers/catalog";
import { piProviderConfig } from "@/lib/providers/registry";
import type { HarnessRoute } from "@/lib/providers/route";
import { HARNESS_BRIDGE_PORT } from "@/lib/sandboxes/harness-bridge";

/**
 * The one HarnessAgent builder (0009 harness stages; the chat pi/claude
 * path since 0022; machine stages deleted by 0037 phase 5). Called
 * fresh inside every workflow step (Node-only; never imported by the
 * workflow body). `stopWhen: isStepCount(1)` makes one `stream()` = one
 * agent step — the semantic-step durability grain the doc decided.
 */

export interface BuildArgs {
  /** 0021: the resolved, validated route — decides harness, provider, model. */
  route: HarnessRoute;
  /** Harness session id (0010 chat: the conversation id). */
  sessionId: string;
  /** Host tools (create_pr, …). */
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
      // `<harness>-<sessionId>` directory — sessions would not see each
      // other's work. "." = the sandbox cwd, the workspace root.
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
    // "." = the sandbox cwd, the workspace root (shared across calls).
    sandboxConfig: { workDir: "." },
    tools,
    stopWhen: isStepCount(1),
  });
}
