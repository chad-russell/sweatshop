import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "./hooks";
import {
  attachSandboxStep,
  bashStep,
  createPrStep,
  listMachinesStep,
  startMachineStep,
} from "./steps";

/**
 * 0010 tool set for the new chat runtime. Built per conversation by
 * buildChatTools (a module-scope factory the workflow body calls —
 * tool executes close over the conversationId, and the whole agent is
 * rebuilt on every body replay so the closures are always fresh).
 *
 * The ask_chad execute deliberately has NO "use step": hook creation
 * needs workflow context (vendored HumanInTheLoop.md — "hooks are
 * workflow-level primitives"), and the enclosing agent step's arguments
 * are serializable (the model rides in SerializableChatModel), so the
 * turn can suspend on the hook mid-loop and resume. The sandbox- and
 * db-touching tools ARE steps — only step bodies may use Node APIs, and
 * their results (clipped/POJO) serialize into the run log.
 */
export function buildChatTools(conversationId: string) {
  return {
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

    bash: tool({
      description:
        "Run a bash command in this conversation's sandbox (a fresh one is created on first use; " +
        "the project's repos are cloned under /work/<conversation>). Not available without a project.",
      inputSchema: z.object({
        command: z.string().max(20_000).describe("The bash command to run."),
      }),
      execute: ({ command }) => bashStep(conversationId, command),
    }),

    create_pr: tool({
      description:
        "Open a pull request for a branch of one of this project's repos (github or forgejo). " +
        "Push the branch first (git push in the sandbox).",
      inputSchema: z.object({
        repo: z.string().describe("Repo directory name under the work root"),
        head: z.string().describe("Branch containing the work"),
        base: z.string().optional().describe("Target branch (default: main)"),
        title: z.string().min(1),
        body: z.string().optional(),
      }),
      execute: (input) => createPrStep(conversationId, input),
    }),

    start_machine: tool({
      description:
        "Start a machine run (a multi-stage pipeline: coding harnesses, agent conversations, and " +
        "Chad's approval gates) and return its URL. Call with no machineId to list machines available here.",
      inputSchema: z.object({
        machineId: z.string().optional().describe("Machine id; omit to list machines"),
        prompt: z.string().optional().describe("The task the run works on (required to start)"),
      }),
      execute: async ({ machineId, prompt }) => {
        if (!machineId) return listMachinesStep(conversationId);
        if (!prompt?.trim()) throw new Error("prompt is required to start a run");
        return startMachineStep(conversationId, { machineId, prompt });
      },
    }),

    attach_sandbox: tool({
      description:
        "Attach this conversation to an existing sandbox (another conversation's or a machine run's) " +
        "instead of using its own — you get your own workdir but share ports and processes with the owner. " +
        "Explicit by design; pass an ownerId (e.g. a machine run id) to join it.",
      inputSchema: z.object({
        ownerKind: z.enum(["conversation", "machine_run"]).optional(),
        ownerId: z.string().optional(),
        sandboxId: z.string().optional(),
      }),
      execute: ({ ownerKind, ownerId, sandboxId }) =>
        attachSandboxStep(
          conversationId,
          sandboxId
            ? { sandboxId }
            : { ownerKind: ownerKind ?? "machine_run", ownerId: ownerId ?? "" },
        ),
    }),

    /** Trivial tool so the mock can force a second model step (steer test). */
    note: tool({
      description: "Record a note to yourself and continue.",
      inputSchema: z.object({ note: z.string().max(2_000) }),
      execute: async ({ note }) => `noted: ${note}`,
    }),
  };
}
