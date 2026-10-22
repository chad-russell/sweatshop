import { db } from "@/db";
import { getConversation, getHarnessResumeState, listModelMessages } from "@/db/chat";
import { createHarnessCall, setCallWorkflowRun, settleHarnessCall } from "@/db/harness-calls";
import {
  claimHarnessRun,
  clipHarnessText,
  MAX_CONCURRENT_HARNESSES,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "@/lib/harness-events";
import { HARNESS_INPUT_CLIP } from "@/lib/harness-limits";
import { cursorCredential } from "@/lib/harness-auth/cursor";
import { codexCredential } from "@/lib/harness-auth/codex";
import { checkRoute, requireRoute } from "@/lib/providers/resolve";
import type { HarnessRoute } from "@/lib/providers/route";
import { resolvePhaseHandoff } from "@/lib/chat/phase-handoff";
import { deriveOutline, prependOutlineHandoff, runnerGate } from "@/lib/outline";
import { start as startWorkflowRun } from "workflow/api";
import { harnessCall } from "@/workflows/chat/harness-call";

/**
 * 0022 cut 2: the chat pi/claude/cursor/codex tools' core — validate, claim a
 * concurrency slot (0038 amendment: at most one running call per kind,
 * at most MAX_CONCURRENT_HARNESSES running in total), record the call,
 * start the `harnessCall` workflow, and return the handle. The turn
 * never advances the harness itself; the result arrives as a wake
 * message. Value-shaped failures so the model reads and reacts (busy =
 * inspect or wait).
 *
 * Plain function (the workflow step wraps it); the `start` seam keeps
 * tests off the workflow runtime and podman.
 */

/**
 * 0040 phase 3: appended to every harness task (pi/claude/cursor/codex, the
 * one place `task` becomes the workflow's prompt) so the delivered
 * result is the harness's own closing statement — not whatever it was
 * doing mid-tool-call when the step loop happened to end (harness-call.ts
 * takes the LAST step's text as the result; this is what makes that
 * step's text worth taking).
 */
export function withResultInstruction(task: string): string {
  return (
    `${task}\n\nEnd with a final message that is your result: what changed (per file), ` +
    "test results, open questions. It is delivered verbatim to the caller; do not end on a progress note."
  );
}

export type StartHarnessCallResult =
  | {
      ok: true;
      callId: string;
      eventsUrl: string;
      note: string;
    }
  | {
      ok: false;
      code: "no-project" | "not-configured" | "busy" | "start-failed" | "not-moded" | "unknown-phase" | "runner-refused" | "route-refused";
      message: string;
    };

export interface HarnessCallWorkflowInput {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  task: string;
  route: HarnessRoute;
  resumeFrom?: unknown;
}

export async function startHarnessCall(
  input: {
    conversationId: string;
    kind: "pi" | "claude" | "cursor" | "codex";
    task: string;
    /** 0055 v7 part B: override the chat's current phase (id or name) —
     *  refuses value-shaped when the chat isn't moded or the phase is
     *  unknown. Absent, the chat's own current phase is used silently
     *  (no refusal — a phaseless/legacy/non-moded chat just runs
     *  unwrapped, same as before 0055). */
    phase?: string;
    /** Test seam: the workflow starter (default: the real runtime). */
    start?: (workflowInput: HarnessCallWorkflowInput) => Promise<{ runId: string }>;
  },
): Promise<StartHarnessCallResult> {
  const conversation = getConversation(db(), input.conversationId);
  const projectId = conversation?.projectId ?? null;
  // 0047 review fix (price cold-start): pi calls are priced — warm the
  // price table on the call path too (fire-and-forget, never blocks).
  import("../usage/prices-refresh").then(({ ensureModelPrices }) =>
    ensureModelPrices(db()).catch(() => {}),
  );
  if (!projectId) {
    return {
      ok: false,
      code: "no-project",
      message: `${input.kind} requires a project conversation — start one from a project page`,
    };
  }
  const outline = deriveOutline(listModelMessages(db(), input.conversationId)).current?.outline ?? null;
  const gate = runnerGate(outline, { kind: "harness", harness: input.kind });
  if (!gate.ok) return { ok: false, code: "runner-refused", message: gate.message };
  if (input.kind === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      ok: false,
      code: "not-configured",
      message:
        "claude is not configured — set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) in the app environment",
    };
  }

  if (input.kind === "cursor") {
    const credential = cursorCredential();
    if (!credential.ok) return { ok: false, code: "not-configured", message: credential.message };
  }

  // 0050: same belt-and-braces gate as cursor's — requireRoute's
  // validation already rejects an un-logged-in codex; this keeps the
  // failure value-shaped with the credential's own way out.
  if (input.kind === "codex") {
    const credential = codexCredential();
    if (!credential.ok) return { ok: false, code: "not-configured", message: credential.message };
  }

  // 0055 v7 part B: resolve the phase handoff before the claim — a
  // refused phase arg must never hold a slot.
  const phaseResolution = await resolvePhaseHandoff(input.conversationId, input.phase);
  if (!phaseResolution.ok) {
    return { ok: false, code: phaseResolution.code, message: phaseResolution.message };
  }

  // 0021: pi inherits the conversation's route, else the project /
  // global default; claude takes its own global setting. Before the
  // claim, so a forbidden route never holds the slot.
  let route: HarnessRoute;
  if (gate.route) {
    const checked = checkRoute(db(), input.kind, { stage: gate.route }, projectId);
    if (!checked.ok) {
      return {
        ok: false,
        code: "route-refused",
        message: `active step "${gate.active?.label ?? "unknown"}" is pinned to a route that cannot run: ${checked.issues.join("; ")} — call update_outline to change the runner`,
      };
    }
    route = checked.route as HarnessRoute;
  } else {
    route = requireRoute(db(), input.kind, { conversation: conversation?.route ?? null }, projectId).route as HarnessRoute;
  }

  // 0038 amendment: up to MAX_CONCURRENT_HARNESSES may run at once per
  // conversation, at most one of each kind — held for each call's whole
  // life (the reaper's busy set reads it).
  const claim = claimHarnessRun(input.conversationId, input.kind);
  if (!claim.ok) {
    const hint = claim.active
      .map((r) => `${r.kind} (events: /h/${r.kind}/${input.conversationId})`)
      .join(", ");
    const message =
      claim.reason === "same-kind"
        ? `a ${input.kind} call is already running in this conversation — inspect it (events: ` +
          `/h/${input.kind}/${input.conversationId}) or cancel_run it before starting another ${input.kind}`
        : `${claim.active.length} harness calls are already running in this conversation ` +
          `(the cap is ${MAX_CONCURRENT_HARNESSES}): ${hint} — inspect or cancel_run one before starting ${input.kind}`;
    return { ok: false, code: "busy", message };
  }

  // 0055 v7 part B: `harness_calls.task` stays the orchestrator's
  // ORIGINAL text (so the card stays readable) — the handoff wrap goes
  // only into the workflow prompt below.
  const call = createHarnessCall(db(), {
    conversationId: input.conversationId,
    kind: input.kind,
    task: input.task,
    phase: phaseResolution.phaseName,
    phaseSkillId: phaseResolution.skillId,
    phaseSkillVersion: phaseResolution.skillVersion,
    phaseId: phaseResolution.phaseId,
    step: gate.active?.label ?? null,
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
      task: withResultInstruction(prependOutlineHandoff(phaseResolution.wrap(input.task), outline).task),
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

  // The task rides on the start event so the session page shows what
  // the harness was asked (the chat card already does).
  recordHarnessEvent(input.conversationId, input.kind, { kind: "start", input: clipHarnessText(input.task, HARNESS_INPUT_CLIP) });
  return {
    ok: true,
    callId: call.id,
    eventsUrl: `/h/${input.kind}/${input.conversationId}/${call.id}`,
    note:
      `running in the background in this conversation's sandbox — the result arrives here as a ` +
      `"[${input.kind} finished]" message; inspect ${call.id} for progress, cancel_run to stop it`,
  };
}
