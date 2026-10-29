/**
 * Child-run tools: start_thread, cancel_run.
 */

import { tool } from "ai";
import { z } from "zod";
import { cancelRunStep, startThreadStep } from "../steps";

export function childTools(
  conversationId: string,
) {
  return {
    start_thread: tool({
      description:
        "Start a fresh child thread — a new chat with deliberately independent context, for work " +
        "that should NOT inherit this thread's reasoning (above all a fresh-eyes review of your own " +
        "work). It runs in the BACKGROUND attached to this sandbox (same checkout; fresh: true gives it " +
        "its own) and THIS conversation is woken with its final message when it settles. Put RAW " +
        "MATERIAL in the prompt — the ticket, the branch, where the evidence is — never your reasoning " +
        "or conclusions. inspect checks on it; cancel_run " +
        "stops it.",
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            "The child's whole task, standalone: the ticket/branch/diff to look at and what to return. " +
              "Raw material only — it must form its own judgment.",
          ),
        fresh: z.boolean().optional().describe("Give the child its own new sandbox instead of sharing this one"),
      }),
      execute: ({ prompt, fresh }) =>
        startThreadStep(conversationId, {
          prompt,
          ...(fresh ? { fresh } : {}),
        }),
    }),

    cancel_run: tool({
      description:
        "Cancel background work you started (or are watching): a background harness call (hc_…) or " +
        "a child thread (c_…) stops and is marked cancelled; sandboxes and work are kept. A " +
        "cancelled child never wakes this conversation. Check state first with inspect if unsure.",
      inputSchema: z.object({
        runId: z.string().min(1).describe("Harness call id (hc_…) or child thread id (c_…)"),
      }),
      execute: ({ runId }) => cancelRunStep(runId),
    }),

    // 0013 Phase 6: post-mortems from outside — no project or binding
    // needed, and neither tool changes this conversation's sandbox.
  };
}
