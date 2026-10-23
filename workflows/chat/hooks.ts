import { defineHook } from "workflow";
import { z } from "zod";
import { MAX_OPTIONS } from "../../lib/question-form";

/**
 * 0010: human input inside a chat turn. A tool that needs Chad creates
 * a hook with its toolCallId as the token and awaits; the inbox and the
 * inline chat card answer via the resume route. Same mechanism as
 * machine human gates (0009 gateHook).
 *
 * Two kinds (matching eve's original input semantics): `approval`
 * (approve/deny + optional comment) and `question` (a freeform answer,
 * or — 0081 — `answers` against a structured `ask_owner` card). The tool
 * validates the payload matches the kind it asked for; `answers` is
 * cross-checked against the stored spec (`lib/question-form.ts`'s
 * `validateAnswers`) by the resume route BEFORE this schema ever sees
 * it, since the valid option ids are per-ask and can't be expressed
 * statically here.
 */
const questionAnswerSchema = z.object({
  selected: z.array(z.string().max(100)).max(MAX_OPTIONS).optional(),
  other: z.string().max(10_000).optional(),
  youPick: z.boolean().optional(),
});

export const chatApprovalHook = defineHook({
  schema: z.object({
    kind: z.enum(["approval", "question"]),
    approved: z.boolean().optional(),
    answer: z.string().max(10_000).optional(),
    comment: z.string().max(10_000).optional(),
    /** 0081: structured ask_owner answers, keyed by question id. */
    answers: z.record(z.string(), questionAnswerSchema).optional(),
  }),
});
