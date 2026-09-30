import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Experimental_SandboxSession } from "ai";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import {
  clipHarnessText,
  getActiveHarnessRun,
  recordHarnessEvent,
  recordHarnessRunEnd,
  recordHarnessRunStart,
} from "../../lib/harness-events";
import { toSandboxSession } from "../../lib/sandboxes/ai-sdk-adapter";
import { connectSandboxToHarnessNetwork } from "../../lib/sandboxes/harness-bridge";

/**
 * 0006: the Claude Code harness, attached to THIS conversation's project
 * sandbox — a sibling of the pi tool, not a replacement. The adapter
 * (@ai-sdk/harness-claude-code) runs the official Claude Agent SDK as a
 * bridge process inside the sandbox; the eve runtime reaches it over the
 * private sweatshop-harness podman network (no published ports).
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
 * One harness session per conversation (module cache, lives while the
 * dev server lives). If the sandbox's bridge endpoint moves (container
 * restart), the cached session is discarded and a fresh one starts —
 * no silent cross-restart reuse of Claude history.
 */

interface CachedClaude {
  agent: HarnessAgent;
  session: Awaited<ReturnType<HarnessAgent["createSession"]>>;
  ip: string;
}

const claudeCache = new Map<string, CachedClaude>();

async function getClaudeHarness(args: {
  sessionId: string;
  sandboxSession: Experimental_SandboxSession;
  ip: string;
}): Promise<CachedClaude> {
  const cached = claudeCache.get(args.sessionId);
  if (cached && cached.ip === args.ip) return cached;
  if (cached) {
    // Endpoint moved (sandbox restarted): drop the stale session rather
    // than silently continuing Claude history that no longer exists.
    await cached.session.destroy().catch(() => undefined);
    claudeCache.delete(args.sessionId);
  }

  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  const harness = createClaudeCode({
    // Explicit direct route: no gateway, no native host-subscription
    // discovery — the only credential is the env merge below.
    auth: "direct",
    port: 4000,
    portEndpoint: { url: `ws://${args.ip}:4000` },
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  const agent = new HarnessAgent({
    harness,
    id: `claude-${args.sessionId}`,
    // The repos live at /workspace — NOT the adapter's default private
    // workdir (0006: shared workspace with eve bash + pi).
    sandboxConfig: { workDir: "." },
  });
  const session = await agent.createSession({ sandboxSession: args.sandboxSession });
  const entry = { agent, session, ip: args.ip };
  claudeCache.set(args.sessionId, entry);
  return entry;
}

export default defineTool({
  description:
    "Hand a coding task to the Claude Code harness, which works in this " +
    "conversation's sandbox (repos under /workspace) with its own " +
    "read/edit/bash tools and keeps context across calls. Prefer for " +
    "deep refactors or nuanced code review; use pi for quick edits and " +
    "plain bash for one-off commands. The repo state is shared — " +
    "claude's edits are immediately visible to bash and pi.",
  inputSchema: z.object({
    task: z.string().min(1).describe("The coding task, with enough context to act on."),
  }),
  async execute({ task }, ctx) {
    const attributes = ctx.session.auth.initiator?.attributes as
      | { project?: unknown }
      | undefined;
    if (typeof attributes?.project !== "string") {
      throw new Error(
        "claude requires a project conversation — start one from a project page",
      );
    }
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error(
        "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN " +
          "(claude setup-token) in the app environment",
      );
    }

    // v1 concurrency contract: one harness at a time per sandbox.
    const active = getActiveHarnessRun(ctx.session.id);
    if (active) {
      throw new Error(
        `a ${active.kind} harness run is already active in this conversation — ` +
          "wait for it to finish before starting claude",
      );
    }

    const eveSandbox = await ctx.getSandbox();
    const sandboxSession = toSandboxSession({
      run: (command, env, workingDirectory) =>
        eveSandbox.run({
          command,
          ...(env ? { env } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        }),
      spawn: (options) => eveSandbox.spawn(options),
    });

    // Private bridge endpoint on the shared harness network (0006).
    const endpoint = await connectSandboxToHarnessNetwork({
      sessionId: ctx.session.id,
      sandbox: {
        run: (command, env) =>
          eveSandbox.run({ command, ...(env ? { env } : {}) }),
      },
    });

    const { agent, session } = await getClaudeHarness({
      sessionId: ctx.session.id,
      sandboxSession,
      ip: endpoint.ip,
    });

    // Event stream (0006 multi-harness): recorded per conversation ×
    // harness into sqlite; served at /h/<sessionId>/claude (raw JSON:
    // /api/harness/<sessionId>?harness=claude).
    recordHarnessRunStart(ctx.session.id, "claude");
    let toolCalls = 0;
    let failure: string | undefined;
    try {
      const result = await agent.generate({
        session,
        prompt: task,
        onStart: () =>
          recordHarnessEvent(ctx.session.id, "claude", { kind: "start" }),
        onStepStart: () =>
          recordHarnessEvent(ctx.session.id, "claude", { kind: "step-start" }),
        onStepEnd: ({ text }) =>
          recordHarnessEvent(ctx.session.id, "claude", {
            kind: "step-end",
            text: clipHarnessText(text, 500),
          }),
        onToolExecutionStart: ({ toolCall }) => {
          toolCalls += 1;
          recordHarnessEvent(ctx.session.id, "claude", {
            kind: "tool-start",
            toolName: toolCall.toolName,
            input: clipHarnessText(toolCall.input, 1000),
          });
        },
        onToolExecutionEnd: ({ toolCall, toolOutput }) =>
          recordHarnessEvent(ctx.session.id, "claude", {
            kind: "tool-end",
            toolName: toolCall.toolName,
            output: clipHarnessText(
              "output" in (toolOutput ?? {})
                ? (toolOutput as { output?: unknown }).output
                : toolOutput,
              2000,
            ),
          }),
        onEnd: () =>
          recordHarnessEvent(ctx.session.id, "claude", { kind: "end" }),
      });
      return {
        text: result.text,
        toolCalls,
        harnessUrl: `/h/${ctx.session.id}/claude`,
        eventLogUrl: `/api/harness/${ctx.session.id}?harness=claude`,
        note: "claude session continues across calls in this conversation.",
      };
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      recordHarnessRunEnd(
        ctx.session.id,
        "claude",
        toolCalls,
        failure ? "failed" : "completed",
        failure,
      );
    }
  },
});
