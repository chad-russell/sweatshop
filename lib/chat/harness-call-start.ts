import { db } from "@/db";
import { getConversation, getHarnessResumeState, listModelMessages } from "@/db/chat";
import { createHarnessCall, setCallWorkflowRun, settleHarnessCall } from "@/db/harness-calls";
import {
  claimHarnessRun,
  clipHarnessText,
  laneSessionId,
  MAX_CONCURRENT_HARNESSES,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "@/lib/harness-events";
import { LANE_BRIDGE_PORTS } from "@/lib/sandboxes/harness-bridge";
import { HARNESS_INPUT_CLIP } from "@/lib/harness-limits";
import { cursorCredential } from "@/lib/harness-auth/cursor";
import { codexCredential } from "@/lib/harness-auth/codex";
import { checkRoute, requireRoute } from "@/lib/providers/resolve";
import type { HarnessRoute } from "@/lib/providers/route";
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
      code: "no-project" | "not-configured" | "busy" | "start-failed" | "runner-refused" | "route-refused";
      message: string;
    };

export interface HarnessCallWorkflowInput {
  callId: string;
  conversationId: string;
  kind: "pi" | "claude" | "cursor" | "codex";
  task: string;
  route: HarnessRoute;
  resumeFrom?: unknown;
  /** 0083: a lane — a fresh session rooted at this sandbox-relative dir,
   *  never chat_harness_state's resume continuity. */
  dir?: string;
  /** 0083: the lane bridge port the claim granted (bridge-backed kinds
   *  only); unset for pi lanes and the default lane. */
  port?: number;
  /** 0083: the harness's OWN session identity for a lane call — distinct
   *  from `conversationId` so a lane never shares pi's in-process session
   *  state (or a bridge harness's internal session bookkeeping) with the
   *  default lane or another lane of the same kind. Unset = use
   *  `conversationId`, today's behavior. */
  harnessSessionId?: string;
}

export async function startHarnessCall(
  input: {
    conversationId: string;
    kind: "pi" | "claude" | "cursor" | "codex";
    task: string;
    /** 0083: run as a lane — a fresh session rooted at this sandbox-
     *  relative dir, running alongside the default lane and other lanes
     *  of this kind. Never resumes/saves chat_harness_state. */
    dir?: string;
    /** Test seam: the workflow starter (default: the real runtime). */
    start?: (workflowInput: HarnessCallWorkflowInput) => Promise<{ runId: string }>;
  },
): Promise<StartHarnessCallResult> {
  const dir = input.dir?.trim() || undefined;
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
  // life (the reaper's busy set reads it). 0083: scoped per (kind, dir) —
  // a lane claims its own slot alongside the default lane and other lanes
  // of the same kind.
  const claim = claimHarnessRun(input.conversationId, input.kind, dir);
  if (!claim.ok) {
    if (claim.reason === "lane-ports") {
      // The pool is leased per sandbox (shared by any attached conversation
      // too, lib/harness-events.ts), so `claim.active` — this conversation's
      // own running calls — may not name every holder; keep the message
      // general rather than claim a count that could be wrong.
      return {
        ok: false,
        code: "busy",
        message:
          `all ${LANE_BRIDGE_PORTS.length} lane ports in this sandbox are in use — ` +
          "inspect or cancel_run a lane, or wait before starting another one",
      };
    }
    const hint = claim.active
      .map((r) => `${r.kind}${r.dir ? ` at ${r.dir}` : ""} (events: /h/${r.kind}/${input.conversationId})`)
      .join(", ");
    const message =
      claim.reason === "same-kind"
        ? dir
          ? `a ${input.kind} lane is already running at ${dir} — inspect it (events: ` +
            `/h/${input.kind}/${input.conversationId}) or cancel_run it, or use a different dir`
          : `a ${input.kind} call is already running in this conversation — inspect it (events: ` +
            `/h/${input.kind}/${input.conversationId}) or cancel_run it before starting another ${input.kind}`
        : `${claim.active.length} harness calls are already running in this conversation ` +
          `(the cap is ${MAX_CONCURRENT_HARNESSES}): ${hint} — inspect or cancel_run one before starting ${input.kind}`;
    return { ok: false, code: "busy", message };
  }

  const call = createHarnessCall(db(), {
    conversationId: input.conversationId,
    kind: input.kind,
    task: input.task,
    step: gate.active?.label ?? null,
    dir,
  });
  // 0083: a lane never reads (or later writes) chat_harness_state — it is
  // a fresh session every call, by design.
  const resumeFrom = dir
    ? undefined
    : getHarnessResumeState(db(), input.conversationId, input.kind) ?? undefined;

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
      task: withResultInstruction(prependOutlineHandoff(input.task, outline).task),
      route,
      ...(resumeFrom ? { resumeFrom } : {}),
      ...(dir ? { dir, harnessSessionId: laneSessionId(input.conversationId, dir) } : {}),
      ...(claim.port !== undefined ? { port: claim.port } : {}),
    });
    setCallWorkflowRun(db(), call.id, workflow.runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    settleHarnessCall(db(), call.id, { status: "failed", error: `could not start: ${message}` });
    recordHarnessRunEnd(input.conversationId, input.kind, 0, "failed", `could not start: ${message}`, dir);
    return { ok: false, code: "start-failed", message: `could not start: ${message}` };
  }

  // The task rides on the start event so the session page shows what
  // the harness was asked (the chat card already does).
  recordHarnessEvent(input.conversationId, input.kind, { kind: "start", input: clipHarnessText(input.task, HARNESS_INPUT_CLIP) }, dir);
  return {
    ok: true,
    callId: call.id,
    eventsUrl: `/h/${input.kind}/${input.conversationId}/${call.id}`,
    note:
      `running in the background in this conversation's sandbox — the result arrives here as a ` +
      `"[${input.kind} finished]" message; inspect ${call.id} for progress, cancel_run to stop it`,
  };
}
