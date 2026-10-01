import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createPi } from "@ai-sdk/harness-pi";
import { defineHarnessTool, eveShell } from "../lib/harness-tool";
import { sandboxContainerIdentity } from "../../lib/sandboxes/identity";
import { toSandboxSession } from "../../lib/sandboxes/ai-sdk-adapter";

/**
 * 0005: the pi coding harness, attached to THIS conversation's project
 * sandbox. pi runs in-process and uses the sandbox as its remote
 * filesystem + shell (no bridge inside the container), on GLM via the
 * Z.AI coding plan's Anthropic Messages surface. Requires a project
 * conversation — the sandbox is the workspace. Everything shared with
 * other harnesses lives in the factory (agent/lib/harness-tool.ts).
 */

const PI_MODEL = process.env.PI_MODEL ?? "zai-glm/glm-5.3-flash";

export default defineHarnessTool({
  kind: "pi",
  description:
    "Hand a coding task to the pi harness, which works in this " +
    "conversation's sandbox (repos under /workspace) with its own " +
    "read/write/edit/bash tools and keeps context across calls. Use for " +
    "non-trivial code changes; use plain bash for quick commands. The " +
    "repo state is shared — pi's edits are immediately visible to bash.",

  toSession: (eveSandbox) => toSandboxSession(eveShell(eveSandbox)),

  // The sandbox container's hostname — it changes exactly when the
  // container is replaced (age-based gc + selector re-run), which is
  // when the cached session must not be reused.
  resolveIdentity: ({ eveSandbox }) => sandboxContainerIdentity(eveSandbox),

  async createSession({ sessionId, sandboxSession }) {
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
    const agent = new HarnessAgent({
      harness: pi,
      id: `pi-${sessionId}`,
      model: PI_MODEL,
    });
    const session = await agent.createSession({ sandboxSession });
    return { agent, session };
  },
});
