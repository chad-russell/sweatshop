import { defineHook } from "workflow";
import { z } from "zod";

/**
 * 0010: human input inside a chat turn. A tool that needs Chad creates
 * a hook with its toolCallId as the token and awaits; the inbox and the
 * inline chat card answer via the resume route. Same mechanism as
 * machine human gates (0009 gateHook).
 *
 * Two kinds (matching eve's original input semantics): `approval`
 * (approve/deny + optional comment) and `question` (a freeform answer).
 * The tool validates the payload matches the kind it asked for.
 */
export const chatApprovalHook = defineHook({
  schema: z.object({
    kind: z.enum(["approval", "question"]),
    approved: z.boolean().optional(),
    answer: z.string().max(10_000).optional(),
    comment: z.string().max(10_000).optional(),
  }),
});
