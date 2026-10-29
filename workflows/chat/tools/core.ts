/**
 * Always-on tools: ask_owner, create_pr, inspect, sandbox_exec, use_skill,
 * save_skill, update_outline, accept_outline, system_docs, and note (0064).
 */

import { tool } from "ai";
import { z, type ZodType } from "zod";
import { chatApprovalHook } from "../hooks";
import { ownerName } from "../../../lib/agent/owner";
import { harnessRouteSchema } from "../../../lib/providers/route";
import { commandDescription } from "./shared";
import type { DiffBreakdown } from "../../../lib/diff-breakdown";
import {
  EVIDENCE_TEXT_MAX,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  QUESTION_TYPES,
  formatStructuredAnswers,
  type StructuredQuestionInput,
} from "../../../lib/question-form";
import {
  acceptOutlineApprovedStep,
  acceptOutlinePreviewStep,
  applyApprovedPromptChangeStep,
  createPrPreviewStep,
  createPrStep,
  inspectStep,
  pendingStep,
  promptChangePreviewStep,
  resolveAskOwnerCardStep,
  sandboxExecStep,
  systemDocsStep,
  updateOutlineStep,
  skillToolStep,
  saveSkillApplyStep,
  saveSkillPreviewStep,
} from "../steps";

/** 0064: a top-level step's runner — "auto" (unrestricted, today's
 *  behavior), "self" (no delegation), "thread" (start_thread only), or a
 *  pinned HarnessRoute. Shape-only here (PR 2 enforces it on the harness
 *  tools and start_thread, and checks the project allow-list). */
const runnerSchema = z.union([z.literal("auto"), z.literal("self"), z.literal("thread"), harnessRouteSchema]);

interface StepInput {
  id: string;
  label: string;
  state: "pending" | "active" | "done" | "skipped" | "blocked";
  detail?: string;
  children?: StepInput[];
}

const STEP_STATE = z.enum(["pending", "active", "done", "skipped", "blocked"]);

/** Children: any depth (lib/outline.ts enforces the real depth/node caps). */
const childStepSchema: ZodType<StepInput> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(200),
    state: STEP_STATE,
    detail: z.string().max(500).optional(),
    children: z.array(childStepSchema).max(200).optional(),
  }),
);

const topStepSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  state: STEP_STATE,
  detail: z.string().max(500).optional(),
  children: z.array(childStepSchema).max(200).optional(),
  runner: runnerSchema.optional(),
});

/** 0081: structured ask_owner sub-questions. Evidence text is capped at
 *  EVIDENCE_TEXT_MAX per option; option-count/uniqueness/recommended
 *  rules that depend on the question's own `type` can't be expressed in
 *  zod alone — validateStructuredQuestions checks those before anything
 *  is written. */
const questionEvidenceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("code"), lang: z.string().max(40).optional(), text: z.string().max(EVIDENCE_TEXT_MAX) }),
  z.object({ type: z.literal("diff"), text: z.string().max(EVIDENCE_TEXT_MAX) }),
  z.object({ type: z.literal("markdown"), text: z.string().max(EVIDENCE_TEXT_MAX) }),
  z.object({ type: z.literal("link"), url: z.string().max(2_000).regex(/^https?:\/\//i, "link evidence must be an http(s) URL"), label: z.string().max(200).optional() }),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().min(1).max(1_000).describe("PNG path inside this chat's sandbox (same rules as attach_screenshot)"),
    label: z.string().max(200).optional(),
  }),
]);

const questionOptionSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  description: z.string().max(1_000).optional(),
  recommended: z.boolean().optional().describe("At most one per single-type question"),
  evidence: questionEvidenceSchema.optional(),
});

const structuredQuestionSchema = z.object({
  id: z.string().min(1).max(100),
  header: z.string().min(1).max(60).describe("Short chip label, e.g. \"Scope\""),
  type: z.enum(QUESTION_TYPES),
  options: z.array(questionOptionSchema).max(MAX_OPTIONS).optional()
    .describe("Required for single/multi/rank (2-8); omit for text"),
  allowOther: z.boolean().optional().describe("Default true. Gates the freeform \"Other…\" alternative only — \"You pick\" is always offered"),
});

export function coreTools(
  conversationId: string,
) {
  return {
    ask_owner: tool({
      description:
        `Ask ${ownerName()} for input. The turn waits for their answer. kind=approval when you want ` +
        "permission to do something (they can approve or deny, optionally with a comment); " +
        "kind=question when you need information or a decision from them. Keep `question` a short " +
        "one-liner that stands alone; put your reasoning, tradeoffs, and why you're asking in `context` " +
        "(markdown). When you're offering a choice, use `questions` with `options` — never \"(a)/(b)\" " +
        `inside prose. ${ownerName()} can always type "you pick" or pick a listed "You pick" option to ` +
        "defer to your recommendation instead — state which option you'd pick and why when that happens.",
      inputSchema: z.object({
        kind: z.enum(["approval", "question"]).describe("approval = permission ask; question = information or a decision needed"),
        question: z.string().max(2_000).describe("A short question that stands alone — reasoning goes in `context`, not here."),
        context: z.string().max(4_000).optional().describe("Markdown: your reasoning, tradeoffs, and relevant detail — not the question itself."),
        questions: z.array(structuredQuestionSchema).min(1).max(MAX_QUESTIONS).optional()
          .describe("Structured sub-questions, kind=question only. \"Other…\" and \"You pick\" are added automatically — never list them as options."),
      }),
      execute: async ({ kind, question, context, questions }, { toolCallId }) => {
        if (questions && questions.length > 0 && kind !== "question") {
          return { ok: false as const, code: "invalid" as const, message: "questions is only valid for kind: question" };
        }
        const resolved = await resolveAskOwnerCardStep(conversationId, {
          context,
          questions: questions as StructuredQuestionInput[] | undefined,
        });
        if (!resolved.ok) return { ok: false as const, code: "invalid" as const, message: resolved.message };
        // The pending row is the inbox's view of this request (a step:
        // only steps may touch sqlite); the hook itself stays the
        // workflow-level suspension primitive.
        await pendingStep(conversationId, toolCallId, question, kind, resolved.card);
        const hook = chatApprovalHook.create({ token: toolCallId });
        const answer = await hook;
        if (answer.kind === "question") {
          if (answer.answers && resolved.card?.questions) {
            return formatStructuredAnswers(resolved.card.questions, answer.answers, ownerName());
          }
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
          | { ok: true; summary: string; evidence: { breakdown?: DiffBreakdown } }
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
        const result = await createPrStep(conversationId, input);
        // 0059: the breakdown computed for the approval card rides on
        // the tool result too, so the transcript's card needs no fetch.
        return result && typeof result === "object"
          ? { ...result, breakdown: preview.evidence.breakdown }
          : result;
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
        "List skills, or load one. With no id, lists every skill (id, description, files). " +
        "With an id, returns that skill's body plus a Files line; with id and file, returns that supporting file. " +
        "Each load is transcript history.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe("Skill id to load; omit to list"),
        file: z.string().min(1).optional().describe("Supporting file path within the skill (e.g. reference.md)"),
      }),
      execute: ({ id, file }) => skillToolStep(conversationId, id, file),
    }),

    save_skill: tool({
      description:
        "Create or replace a skill in the skills catalog. `body` is the whole SKILL.md including front matter " +
        "(`---`, `description: <when to use it>`, optional `status: disabled`, `---`) then the runbook markdown; " +
        "`files` are supporting files (POSIX-relative paths) that REPLACE the skill's current set. Limits: 16 files, " +
        `64 KiB per file, 256 KiB per skill. ${ownerName()} approves every save — the card shows a diff for an edit ` +
        "and the full content for a new skill; the skill is written only when they accept. Load the current version " +
        "with use_skill first when editing.",
      inputSchema: z.object({
        id: z.string().describe("Skill id: lowercase letter first, then lowercase letters/digits/hyphens (≤41 chars)"),
        body: z.string().describe("Full SKILL.md text, front matter with a description included"),
        files: z
          .array(z.object({ path: z.string(), content: z.string() }))
          .max(15)
          .optional()
          .describe("Supporting files; the complete set the skill should have after this save"),
        note: z.string().trim().max(500).optional().describe("What changed and why"),
      }),
      execute: async (input, { toolCallId }) => {
        const preview = await saveSkillPreviewStep(input);
        if (!preview.ok) return preview;
        await pendingStep(conversationId, toolCallId, preview.summary, "approval", preview.card);
        const answer = await chatApprovalHook.create({ token: toolCallId });
        if (!(answer.kind === "approval" && answer.approved)) {
          const comment = answer.kind === "approval" ? answer.comment?.trim() : undefined;
          return {
            ok: false,
            code: comment ? ("changes-requested" as const) : ("denied" as const),
            message: comment
              ? `${ownerName()} sent the skill back with changes — nothing was saved. Address this, then call save_skill again: ${comment}`
              : `${ownerName()} declined — nothing was saved`,
          };
        }
        return saveSkillApplyStep(input);
      },
    }),

    update_outline: tool({
      description:
        "Rewrite this thread's outline: the goal, and a step tree for plan/status/to-dos. For multi-step work only — " +
        "a chat that never calls it shows no outline. Pass the WHOLE outline every time: a one-line goal, and steps " +
        "with a stable id (kept across rewrites), a label, and a state (pending, active, done, skipped, blocked). " +
        "Children can go any number of levels deep (depth 4, 200 steps total) — only TOP-LEVEL steps are the unit of " +
        "delegation and may carry a runner (auto/self/thread/a pinned harness route); children are that step's own " +
        `to-do list. Pass propose: true to open a review on ${ownerName()}'s screen for this version — it never ` +
        "blocks, keep working; approval arrives as an [outline approved] message (or accept_outline when they say so " +
        "in chat). Call it whenever the active step, a child, or a blocker changes, including after a wake. The " +
        "header chip and the next [thread state] note read the latest call.",
      inputSchema: z.object({
        goal: z.string().min(1).max(300),
        steps: z.array(topStepSchema).min(1).max(200),
        note: z.string().max(500).optional().describe("One line of context, optional"),
        propose: z.boolean().optional().describe(`Open a review on ${ownerName()}'s screen for this version`),
      }),
      execute: (input, { toolCallId, messages }) => {
        // The live prompt holds this turn's earlier snapshots (a turn
        // persists slice by slice) — the version count needs them.
        const live = messages.filter((m) => m.role === "tool");
        return updateOutlineStep(conversationId, toolCallId, input, live);
      },
    }),

    accept_outline: tool({
      description:
        `When ${ownerName()} approves the outline in chat ("looks good, go"), call this instead of proceeding on your ` +
        "reading: it puts an Approve button for the outline version in review on their screen and waits. Approved → " +
        "continue. Denied → their comment is feedback; the review stays open.",
      inputSchema: z.object({}),
      execute: async (_input, { toolCallId }) => {
        const preview = (await acceptOutlinePreviewStep(conversationId)) as
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
              ? `${ownerName()} did not approve yet: ${comment} — the review stays open; revise and present again.`
              : `${ownerName()} did not approve — the review stays open.`,
          };
        }
        return acceptOutlineApprovedStep(preview.rowId, answer.comment?.trim() || undefined);
      },
    }),

    propose_prompt_change: tool({
      description:
        "Propose a change to an app prompt section or the skill catalog. This can edit prompt/skill text, " +
        `create a skill, or change a skill's description, thread binding, or reversible status. ${ownerName()} sees the ` +
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
            message: comment || `${ownerName()} declined — nothing was changed`,
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
