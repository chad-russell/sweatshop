import { db } from "@/db";
import { getConversation, getHarnessResumeState } from "@/db/chat";
import { createHarnessCall, setCallWorkflowRun, settleHarnessCall } from "@/db/harness-calls";
import {
  claimHarnessRun,
  getActiveHarnessRun,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "@/lib/harness-events";
import { requireRoute } from "@/lib/providers/resolve";
import type { HarnessRoute } from "@/lib/providers/route";
import { start as startWorkflowRun } from "workflow/api";
import { harnessCall } from "@/workflows/chat/harness-call";

/**
 * 0022 cut 2: the chat pi/claude tools' core — validate, claim the
 * one-per-session slot, record the call, start the `harnessCall`
 * workflow, and return the handle. The turn never advances the harness
 * itself; the result arrives as a wake message. Value-shaped failures
 * so the model reads and reacts (busy = inspect or wait).
 *
 * Plain function (the workflow step wraps it); the `start` seam keeps
 * tests off the workflow runtime and podman.
 */

export type StartHarnessCallResult =
  | {
      ok: true;
      callId: string;
      eventsUrl: string;
      note: string;
    }
  | {
      ok: false;
      code: "no-project" | "not-configured" | "busy" | "start-failed";
      message: string;
    };

export interface HarnessCallWorkflowInput {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude";
  task: string;
  route: HarnessRoute;
  resumeFrom?: unknown;
}

export async function startHarnessCall(
  input: {
    conversationId: string;
    kind: "pi" | "claude";
    task: string;
    /** Test seam: the workflow starter (default: the real runtime). */
    start?: (workflowInput: HarnessCallWorkflowInput) => Promise<{ runId: string }>;
  },
): Promise<StartHarnessCallResult> {
  const conversation = getConversation(db(), input.conversationId);
  const projectId = conversation?.projectId ?? null;
  if (!projectId) {
    return {
      ok: false,
      code: "no-project",
      message: `${input.kind} requires a project conversation — start one from a project page`,
    };
  }
  if (input.kind === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      ok: false,
      code: "not-configured",
      message:
        "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) in the app environment",
    };
  }

  // 0021: pi inherits the conversation's route, else the project /
  // global default; claude takes its own global setting. Before the
  // claim, so a forbidden route never holds the slot.
  const { route } = requireRoute(db(), input.kind, { conversation: conversation?.route ?? null }, projectId);

  // v1 concurrency contract: one harness at a time per session (0006) —
  // held for the call's whole life now (the reaper's busy set reads it).
  if (!claimHarnessRun(input.conversationId, input.kind)) {
    const active = getActiveHarnessRun(input.conversationId);
    return {
      ok: false,
      code: "busy",
      message:
        `a ${active?.kind ?? "harness"} call is already active in this conversation — ` +
        `inspect it (events: /h/${active?.kind ?? "pi"}/${input.conversationId}) ` +
        `or cancel_run it before starting ${input.kind}`,
    };
  }

  const call = createHarnessCall(db(), {
    conversationId: input.conversationId,
    kind: input.kind,
    task: input.task,
  });
  const resumeFrom = getHarnessResumeState(db(), input.conversationId, input.kind) ?? undefined;

  try {
    const startWorkflow =
      input.start ??
      (async (workflowInput: HarnessCallWorkflowInput) => {
        const workflow = await startWorkflowRun(harnessCall, [workflowInput]);
        return { runId: workflow.runId };
      });
    const workflow = await startWorkflow({
      callId: call.id,
      conversationId: input.conversationId,
      kind: input.kind,
      task: input.task,
      route,
      ...(resumeFrom ? { resumeFrom } : {}),
    });
    setCallWorkflowRun(db(), call.id, workflow.runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    settleHarnessCall(db(), call.id, { status: "failed", error: `could not start: ${message}` });
    recordHarnessRunEnd(input.conversationId, input.kind, 0, "failed", `could not start: ${message}`);
    return { ok: false, code: "start-failed", message: `could not start: ${message}` };
  }

  recordHarnessEvent(input.conversationId, input.kind, { kind: "start" });
  return {
    ok: true,
    callId: call.id,
    eventsUrl: `/h/${input.kind}/${input.conversationId}`,
    note:
      `running in the background in this conversation's sandbox — the result arrives here as a ` +
      `"[${input.kind} finished]" message; inspect ${call.id} for progress, cancel_run to stop it`,
  };
}
