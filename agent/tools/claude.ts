import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { defineHarnessTool, eveShell } from "../lib/harness-tool";
import { toSandboxSession } from "../../lib/sandboxes/ai-sdk-adapter";
import { connectSandboxToHarnessNetwork } from "../../lib/sandboxes/harness-bridge";

/**
 * 0006: the Claude Code harness, attached to THIS conversation's project
 * sandbox — a sibling of the pi tool, not a replacement. The adapter
 * (@ai-sdk/harness-claude-code) runs the official Claude Agent SDK as a
 * bridge process inside the sandbox; the eve runtime reaches it over the
 * private sweatshop-harness podman network (no published ports).
 * Everything shared with other harnesses lives in the factory
 * (agent/lib/harness-tool.ts).
 *
 * Auth (0006 amendment, Chad's explicit decision 2026-09-30): the
 * token is passed as CLAUDE_CODE_OAUTH_TOKEN — a claude setup-token
 * (subscription OAuth) — through the adapter's env channel, which
 * merges it into the in-sandbox Claude Code process. Rationale: this
 * is a single-user, self-hosted personal tool, offered to no one; if
 * sweatshop is ever productized, each user runs their own credential
 * for their own work. No API-key disguise, no host-env scraping
 * (auth: "direct" with no ANTHROPIC_* keys set).
 *
 * Cache identity is the bridge endpoint IP: it moves exactly when the
 * sandbox container does, so a replaced sandbox evicts the cached
 * session — no silent cross-restart reuse of Claude history.
 */

export default defineHarnessTool({
  kind: "claude",
  description:
    "Hand a coding task to the Claude Code harness, which works in this " +
    "conversation's sandbox (repos under /workspace) with its own " +
    "read/edit/bash tools and keeps context across calls. Prefer for " +
    "deep refactors or nuanced code review; use pi for quick edits and " +
    "plain bash for one-off commands. The repo state is shared — " +
    "claude's edits are immediately visible to bash and pi.",

  requireConfigured: () =>
    process.env.CLAUDE_CODE_OAUTH_TOKEN
      ? null
      : "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN " +
        "(claude setup-token) in the app environment",

  // claude's bridge is a long-lived in-sandbox process: pass eve's real
  // streaming spawn through (0006 — replay cannot host a bridge).
  toSession: (eveSandbox) =>
    toSandboxSession({
      ...eveShell(eveSandbox),
      spawn: (options) => eveSandbox.spawn(options),
    }),

  // Private bridge endpoint on the shared harness network (0006).
  resolveIdentity: async ({ sessionId, eveSandbox }) =>
    (
      await connectSandboxToHarnessNetwork({
        sessionId,
        sandbox: eveShell(eveSandbox),
      })
    ).ip,

  async createSession({ sessionId, sandboxSession, identity }) {
    if (identity === null) {
      throw new Error("claude requires a resolved bridge endpoint");
    }
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
    const harness = createClaudeCode({
      // Explicit direct route: no gateway, no native host-subscription
      // discovery — the only credential is the env merge below.
      auth: "direct",
      port: 4000,
      portEndpoint: { url: `ws://${identity}:4000` },
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
    const agent = new HarnessAgent({
      harness,
      id: `claude-${sessionId}`,
      // The repos live at /workspace — NOT the adapter's default private
      // workdir (0006: shared workspace with eve bash + pi).
      sandboxConfig: { workDir: "." },
    });
    const session = await agent.createSession({ sandboxSession });
    return { agent, session };
  },
});
