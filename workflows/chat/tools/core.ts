/**
 * Always-on tools: ask_chad, create_pr, inspect, sandbox_exec, use_skill, system_docs, note.
 */

import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "../hooks";
import { ownerName } from "../../../lib/agent/owner";
import { commandDescription } from "./shared";
import { applyApprovedPromptChangeStep, bindSkillStep, createPrPreviewStep, createPrStep, inspectStep, pendingStep, promptChangePreviewStep, sandboxExecStep, systemDocsStep } from "../steps";

export function coreTools(
  conversationId: string,
) {
  return {
    ask_chad: tool({
      description:
        `Ask ${ownerName()} for input. The turn waits for their answer. kind=approval when you want ` +
        "permission to do something (they can approve or deny, optionally with a comment); " +
        "kind=question when you need information or a freeform decision from them.",
      inputSchema: z.object({
        kind: z.enum(["approval", "question"]).describe("approval = permission ask; question = freeform answer needed"),
        question: z.string().max(2_000).describe("What you are asking, phrased so it stands alone."),
      }),
      execute: async ({ kind, question }, { toolCallId }) => {
        // The pending row is the inbox's view of this request (a step:
        // only steps may touch sqlite); the hook itself stays the
        // workflow-level suspension primitive.
        await pendingStep(conversationId, toolCallId, question, kind);
        const hook = chatApprovalHook.create({ token: toolCallId });
        const answer = await hook;
        if (answer.kind === "question") {
          if (typeof answer.answer !== "string" || !answer.answer.trim()) {
            return `${ownerName()} did not answer the question. Question was: ${question}`;
          }
          return `${ownerName()} answered: ${answer.answer.trim()}`;
        }
        const { approved, comment } = answer;
        return approved
          ? `${ownerName()} approved${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`
          : `${ownerName()} denied${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`;
      },
    }),

    create_pr: tool({
      description:
        "Open a pull request for a branch of one of this project's repos (github or forgejo). " +
        `Push the branch first (git push in the sandbox). ${ownerName()} approves every PR — the turn waits ` +
        "on their answer (the card shows the commits and diffstat) and the PR opens only when they accept.",
      inputSchema: z.object({
        repo: z.string().describe("Repo directory name under the work root"),
        head: z.string().describe("Branch containing the work"),
        base: z.string().optional().describe("Target branch (default: main)"),
        title: z.string().min(1),
        body: z.string().optional(),
      }),
      // 0034 Phase A: approval-gated like create_machine — never a
      // silent PR. Invalid proposals return to the model without asking.
      execute: async (input, { toolCallId, messages }) => {
        // The live prompt carries this turn's attachments (a turn
        // persists only at its end — run 5's card missed three).
        const live = messages.filter((m) => m.role === "tool" || m.role === "assistant");
        const preview = (await createPrPreviewStep(conversationId, input, live)) as
          | { ok: true; summary: string; evidence: unknown }
          | { ok: false; code: string; message: string };
        if (!preview.ok) return preview;
        // 0037: the card carries the runtime's evidence (test run +
        // the thread's screenshots), not the model's say-so.
        await pendingStep(conversationId, toolCallId, preview.summary, "approval", preview.evidence);
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          // 0037: a comment is a revise — Chad typed changes he wants.
          const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
          return {
            ok: false,
            code: comment ? ("changes-requested" as const) : ("denied" as const),
            message: comment
              ? `${ownerName()} sent the PR back with changes — nothing was opened. Address this, then call create_pr again: ${comment}`
              : `${ownerName()} declined the PR — nothing was opened`,
          };
        }
        return createPrStep(conversationId, input);
      },
    }),

    inspect: tool({
      description:
        "Look at another chat without joining it: its status, transcript tail, " +
        "harness (pi/claude) activity, which sandbox it is bound to, and where each sandboxed call ran. " +
        "Pass a chat id (c_…). Read-only.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Chat id (c_…)"),
      }),
      execute: ({ id }) => inspectStep(id),
    }),

    sandbox_exec: tool({
      description:
        "Run one shell command inside another chat's sandbox without binding this conversation " +
        "to it (e.g. `git log`, `ls`, run the tests) — it runs in that sandbox's working directory. " +
        "Target a sandbox id (sbx_…) or a chat id. A stopped sandbox is resumed; a destroyed one cannot be.",
      inputSchema: z.object({
        target: z.string().min(1).describe("Sandbox id (sbx_…) or chat id (c_…)"),
        command: z.string().min(1).max(20_000).describe("The bash command to run."),
        description: commandDescription,
        workDir: z.string().optional().describe("Override the working directory (absolute path)"),
      }),
      execute: ({ target, command, workDir }) => sandboxExecStep(target, command, workDir),
    }),
    use_skill: tool({
      description:
        "Run this thread by a skill — a runbook for a kind of work (e.g. \"ship\": ticket to approved PR). " +
        `Call it when ${ownerName()} asks for that kind of work mid-thread (\"ship it\"); the skill then guides every ` +
        "later turn and the thread gets the background work budget. Omit id to list skills.",
      inputSchema: z.object({ id: z.string().optional().describe("Skill id; omit to list") }),
      execute: ({ id }) => bindSkillStep(conversationId, id),
    }),

    propose_prompt_change: tool({
      description:
        "Propose a change to an app prompt section or the skill catalog. This can edit prompt/skill text, " +
        "create a skill, or change a skill's description, thread binding, or reversible status. Chad sees the " +
        "complete change and must explicitly approve before it is written. This cannot change tools, approval " +
        "gates, command restrictions, or provider/model validation.",
      inputSchema: z.object({
        kind: z.enum(["section", "skill"]),
        key: z.string().describe("base|harness_steering|host_routing, or a skill id"),
        body: z.string().max(64 * 1024).optional(),
        description: z.string().max(500).optional().describe("skill only"),
        thread: z.boolean().optional().describe("skill only"),
        status: z.enum(["active", "disabled", "deleted"]).optional().describe("skill only"),
        note: z.string().trim().min(1).max(500).refine((value) => !/[\r\n]/.test(value), "note must be one line").describe("What changed and why"),
      }),
      execute: async (input, { toolCallId }) => {
        const preview = await promptChangePreviewStep(input);
        if (!preview.ok) return preview;
        await pendingStep(conversationId, toolCallId, preview.summary, "approval", preview.card);
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
          return {
            ok: false,
            code: "denied" as const,
            message: comment || "Chad declined — nothing was changed",
          };
        }
        return applyApprovedPromptChangeStep(
          preview.target,
          preview.patch,
          preview.expectedVersion,
          input.note,
        );
      },
    }),

    system_docs: tool({
      description:
        "Read a capability doc: how this system's pieces work and how to drive them — " +
        "projects, previews, sandboxes, models. Call it before setting one up, " +
        `explaining one to ${ownerName()}, or when a capability behaves unexpectedly. Omit topic to list what exists.`,
      inputSchema: z.object({
        topic: z.string().optional().describe("The doc to read (e.g. \"machines\"); omit to list topics"),
      }),
      execute: ({ topic }) => systemDocsStep(topic),
    }),

    /** Trivial tool so the mock can force a second model step (steer test). */
    note: tool({
      description: "Record a note to yourself and continue.",
      inputSchema: z.object({ note: z.string().max(2_000) }),
      execute: async ({ note }) => `noted: ${note}`,
    }),
  };
}
