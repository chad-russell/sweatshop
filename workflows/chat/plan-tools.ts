import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "./hooks";
import { acceptPlanApprovedStep, acceptPlanPreviewStep, pendingStep, presentPlanStep } from "./steps";

/**
 * 0041: the plan tools. present_plan never suspends (a review is a
 * hookless pending row — the Inbox's "needs you", nothing more);
 * accept_plan is approval-gated like every gated tool (0034 A), so a
 * chat "looks good" becomes approval only on Chad's explicit click.
 * accept_plan's execute has no "use step" for the same reason ask_chad's
 * does: hook creation needs workflow context.
 */
export function planTools(conversationId: string) {
  return {
    present_plan: tool({
      description:
        "Show Chad the plan: snapshots PLAN.md from the work root (beside the repos — never inside one; write and " +
        "edit it with bash like any file) as a versioned card with a diff against the last version. Returns at " +
        "once — never waits. Before approval it opens a review: keep exploring and answering Chad, edit the file, " +
        "and present again; each new version should say which of his points it addressed or declined. Approval " +
        "arrives as a [plan approved] message. After approval, calling it shows progress (tick the file's " +
        "`- [ ]` checklist first); pass reapprove: true when the scope changed materially.",
      inputSchema: z.object({
        note: z.string().max(500).optional().describe("One line on what changed in this version"),
        reapprove: z.boolean().optional().describe("After approval: the scope changed — ask Chad to approve again"),
      }),
      execute: (input, { toolCallId, messages }) => {
        // The live prompt holds this turn's earlier snapshots (a turn
        // persists slice by slice) — the version count needs them.
        const live = messages.filter((m) => m.role === "tool");
        return presentPlanStep(conversationId, toolCallId, input, live);
      },
    }),

    accept_plan: tool({
      description:
        "When Chad approves the plan in chat (\"looks good, go\"), call this instead of proceeding on your reading: " +
        "it puts an Approve button for the plan version in review on his screen and waits. Approved → build. " +
        "Denied → his comment is feedback; the review stays open.",
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        const preview = (await acceptPlanPreviewStep(conversationId)) as
          | { ok: true; rowId: string; card: unknown; summary: string }
          | { ok: false; code: string; message: string };
        if (!preview.ok) return preview;
        await pendingStep(conversationId, toolCallId, preview.summary, "approval", preview.card);
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
          return {
            approved: false as const,
            message: comment
              ? `Chad did not approve yet: ${comment} — the review stays open; revise and present again.`
              : "Chad did not approve — the review stays open.",
          };
        }
        return acceptPlanApprovedStep(preview.rowId, answer.comment?.trim() || undefined);
      },
    }),
  };
}
