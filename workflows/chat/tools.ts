import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "./hooks";

/**
 * 0010 spike tool set. ask_chad's execute deliberately has NO "use
 * step": hook creation needs workflow context (vendored HumanInTheLoop.md
 * — "hooks are workflow-level primitives"), and the enclosing agent step's
 * arguments are serializable (the model rides in SerializableChatModel),
 * so the turn can suspend on the hook mid-loop and resume. Tools stay
 * module-scope exports so the workflow body can reference them without
 * closure capture.
 */
export const chatTools = {
  /** Ask Chad a yes/no question mid-turn; the turn suspends until answered. */
  ask_chad: tool({
    description:
      "Ask Chad for approval or a decision before doing something consequential. The turn waits for his answer.",
    inputSchema: z.object({
      question: z.string().max(2_000).describe("What you need a decision on."),
    }),
    execute: async ({ question }, { toolCallId }) => {
      const hook = chatApprovalHook.create({ token: toolCallId });
      const { approved, comment } = await hook;
      return approved
        ? `Chad approved${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`
        : `Chad denied${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`;
    },
  }),

  /** Trivial tool so the mock can force a second model step (steer test). */
  note: tool({
    description: "Record a note to yourself and continue.",
    inputSchema: z.object({ note: z.string().max(2_000) }),
    execute: async ({ note }) => `noted: ${note}`,
  }),
};
