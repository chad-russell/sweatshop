import { defineTool } from "eve/tools";
import { z } from "zod";
import type { Experimental_SandboxSession } from "ai";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessKind } from "../../lib/harness-events";
import {
  claimHarnessRun,
  clipHarnessText,
  getActiveHarnessRun,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "../../lib/harness-events";
import { toSandboxSession } from "../../lib/sandboxes/ai-sdk-adapter";
import type { SandboxShell } from "../../lib/sandbox-shell";
import { sessionProjectId } from "../../lib/session-attributes";

/**
 * The harness-tool factory (0005/0006): everything pi and claude (and
 * the next bridge-backed harness) share — the project-conversation
 * gate, the atomic one-run-per-sandbox claim (0006), the per-
 * conversation session cache with sandbox-replacement eviction, the
 * sqlite event stream, and the failure bookkeeping. A harness tool
 * file declares its kind plus the few genuinely harness-specific hooks
 * and exports `defineHarnessTool({ ... })` as its default.
 *
 * The kind is the tool's whole public identity: HARNESS_KINDS
 * (lib/harness-events) validates it for routes, and /h/<kind>/<id>,
 * /api/harness/<id>?harness=<kind> and the chat tool cards all derive
 * from it. Adding a harness = one spec file + one entry in
 * HARNESS_KINDS.
 */

/** An eve session-sandbox handle, as the tools use it. */
export interface EveSandbox {
  run(options: {
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
  spawn: Experimental_SandboxSession["spawn"];
}

/** Wrap an eve sandbox handle as the canonical string-command shell. */
export function eveShell(eveSandbox: EveSandbox): SandboxShell {
  return {
    run: (command, env, workingDirectory) =>
      eveSandbox.run({
        command,
        ...(env ? { env } : {}),
        ...(workingDirectory ? { workingDirectory } : {}),
      }),
  };
}

export type HarnessSession = Awaited<ReturnType<HarnessAgent["createSession"]>>;

export interface HarnessToolSpec {
  /** Harness discriminator — must be one of HARNESS_KINDS. */
  kind: HarnessKind;
  /** The tool description the model sees. */
  description: string;
  /**
   * Configuration gate: return an error message when the harness is
   * not usable in this environment (e.g. missing token); return null
   * (or omit the hook) when ready.
   */
  requireConfigured?: () => string | null;
  /** Wrap eve's session sandbox as an AI SDK sandbox session. */
  toSession(eveSandbox: EveSandbox): Experimental_SandboxSession;
  /**
   * Cache identity for this call, === compared against the cached
   * session's: it must change exactly when the cached session must not
   * be reused — i.e. when the sandbox container was replaced (pi probes
   * the container hostname; claude uses its bridge endpoint IP). null
   * means "identity unknown" and always rebuilds, never reuses.
   */
  resolveIdentity(args: {
    sessionId: string;
    eveSandbox: EveSandbox;
  }): Promise<string | null>;
  /** Build the harness agent + session for this conversation. */
  createSession(args: {
    sessionId: string;
    identity: string | null;
    sandboxSession: Experimental_SandboxSession;
  }): Promise<{ agent: HarnessAgent; session: HarnessSession }>;
}

export function defineHarnessTool(spec: HarnessToolSpec) {
  const cache = new Map<
    string,
    { identity: string | null; agent: HarnessAgent; session: HarnessSession }
  >();

  return defineTool({
    description: spec.description,
    inputSchema: z.object({
      task: z.string().min(1).describe("The coding task, with enough context to act on."),
    }),
    async execute({ task }, ctx) {
      if (!sessionProjectId(ctx.session)) {
        throw new Error(
          `${spec.kind} requires a project conversation — start one from a project page`,
        );
      }
      const notConfigured = spec.requireConfigured?.();
      if (notConfigured) throw new Error(notConfigured);

      // v1 concurrency contract: one harness at a time per sandbox (0006).
      // The claim is atomic (check + start in one sqlite transaction) so
      // concurrent calls cannot both pass the guard.
      if (!claimHarnessRun(ctx.session.id, spec.kind)) {
        const active = getActiveHarnessRun(ctx.session.id);
        throw new Error(
          `a ${active?.kind ?? "harness"} run is already active in this conversation — ` +
            `wait for it to finish before starting ${spec.kind}`,
        );
      }

      let toolCalls = 0;
      let failure: string | undefined;
      try {
        const eveSandbox: EveSandbox = await ctx.getSandbox();
        const sandboxSession = spec.toSession(eveSandbox);
        const identity = await spec.resolveIdentity({
          sessionId: ctx.session.id,
          eveSandbox,
        });

        let entry = cache.get(ctx.session.id);
        if (!(entry && identity !== null && entry.identity === identity)) {
          if (entry) {
            // Sandbox replaced under us: drop the stale session rather
            // than continuing harness history against a dead container.
            await entry.session.destroy().catch(() => undefined);
            cache.delete(ctx.session.id);
          }
          entry = {
            identity,
            ...(await spec.createSession({
              sessionId: ctx.session.id,
              identity,
              sandboxSession,
            })),
          };
          cache.set(ctx.session.id, entry);
        }

        // Full harness event stream (0005 visibility, 0006 multi-
        // harness): every model step and tool call is recorded per
        // conversation × harness into sqlite (raw JSON:
        // /api/harness/<sessionId>?harness=<kind>).
        const rec = harnessEventRecorder(ctx.session.id, spec.kind, () => {
          toolCalls += 1;
        });
        const result = await entry.agent.generate({
          session: entry.session,
          prompt: task,
          onStart: rec.start,
          onStepStart: rec.stepStart,
          onStepEnd: ({ text }) => rec.stepEnd(text),
          onToolExecutionStart: ({ toolCall }) =>
            rec.toolStart(toolCall.toolName, toolCall.input),
          onToolExecutionEnd: ({ toolCall, toolOutput }) =>
            rec.toolEnd(
              toolCall.toolName,
              "output" in (toolOutput ?? {})
                ? (toolOutput as { output?: unknown }).output
                : toolOutput,
            ),
          onEnd: rec.end,
        });
        return {
          text: result.text,
          toolCalls,
          harnessUrl: `/h/${spec.kind}/${ctx.session.id}`,
          eventLogUrl: `/api/harness/${ctx.session.id}?harness=${spec.kind}`,
          note: `${spec.kind} session continues across calls in this conversation.`,
        };
      } catch (err) {
        // 0006: failures are failures — keep the transcript, record why.
        failure = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        recordHarnessRunEnd(
          ctx.session.id,
          spec.kind,
          toolCalls,
          failure ? "failed" : "completed",
          failure,
        );
      }
    },
  });
}

/** The 0005/0006 sqlite event recording — identical for every harness. */
function harnessEventRecorder(
  sessionId: string,
  harness: HarnessKind,
  countToolCall: () => void,
) {
  return {
    start: () => recordHarnessEvent(sessionId, harness, { kind: "start" }),
    stepStart: () =>
      recordHarnessEvent(sessionId, harness, { kind: "step-start" }),
    stepEnd: (text: unknown) =>
      recordHarnessEvent(sessionId, harness, {
        kind: "step-end",
        text: clipHarnessText(text, 500),
      }),
    toolStart: (toolName: string, input: unknown) => {
      countToolCall();
      recordHarnessEvent(sessionId, harness, {
        kind: "tool-start",
        toolName,
        input: clipHarnessText(input, 1000),
      });
    },
    toolEnd: (toolName: string, output: unknown) =>
      recordHarnessEvent(sessionId, harness, {
        kind: "tool-end",
        toolName,
        output: clipHarnessText(output, 2000),
      }),
    end: () => recordHarnessEvent(sessionId, harness, { kind: "end" }),
  };
}
