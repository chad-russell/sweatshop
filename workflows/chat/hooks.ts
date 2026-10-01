import { defineHook } from "workflow";
import { z } from "zod";

/**
 * 0010 spike: human input inside a chat turn. A tool that needs Chad
 * creates a hook with its toolCallId as the token and awaits; the inbox
 * (Phase 4) and the /x page answer via the resume route. Same mechanism
 * as machine human gates (0009 gateHook).
 */
export const chatApprovalHook = defineHook({
  schema: z.object({
    approved: z.boolean(),
    comment: z.string().max(10_000).optional(),
  }),
});
