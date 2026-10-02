import { tool } from "ai";
import { z } from "zod";
import { chatApprovalHook } from "./hooks";
import { harnessToolStep } from "./harness-step";
import {
  bashStep,
  createPrStep,
  listMachinesStep,
  pendingStep,
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
 *
 * 0013: the conversation's sandbox binding decides the sandboxed tools —
 * "none" (no project, or "no sandbox" chosen) omits bash/pi/claude;
 * pending or bound keeps bash, and pi/claude also need a project (their
 * create_pr host tool is project-scoped). The tool cores open the
 * binding themselves; nothing here picks a sandbox.
 */
export function buildChatTools(
  conversationId: string,
  sandbox: { hasSandbox: boolean; hasProject: boolean } = { hasSandbox: true, hasProject: true },
) {
  const { hasSandbox, hasProject } = sandbox;
  return {
    ask_chad: tool({
      description:
        "Ask Chad for input. The turn waits for his answer. kind=approval when you want " +
        "permission to do something (he can approve or deny, optionally with a comment); " +
        "kind=question when you need information or a freeform decision from him.",
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
            return `Chad did not answer the question. Question was: ${question}`;
          }
          return `Chad answered: ${answer.answer.trim()}`;
        }
        const { approved, comment } = answer;
        return approved
          ? `Chad approved${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`
          : `Chad denied${comment ? `: ${comment}` : " (no comment)"}. Question was: ${question}`;
      },
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

    // 0011/0013: chats are not offered tools that can only error — bash
    // needs a sandbox binding; pi/claude also need a project.
    ...(hasSandbox && {
      bash: tool({
        description:
          "Run a bash command in this conversation's sandbox, in its working directory (a project " +
          "chat's own sandbox is created on first use with the repos cloned there; an attached chat " +
          "works in the sandbox and directory it attached to).",
        inputSchema: z.object({
          command: z.string().max(20_000).describe("The bash command to run."),
        }),
        execute: ({ command }, { toolCallId }) => bashStep(conversationId, command, toolCallId),
      }),
    }),
    ...(hasSandbox && hasProject && {
      pi: tool({
        description:
          "Hand a coding task to the pi harness, which works in this conversation's sandbox " +
          "(repos under the work root) with its own read/write/edit/bash tools and keeps context " +
          "across calls. Use for non-trivial code changes; use plain bash for quick commands. " +
          "The repo state is shared — pi's edits are immediately visible to bash.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }, { toolCallId }) =>
          harnessToolStep({ conversationId, kind: "pi", task, toolCallId }),
      }),

      claude: tool({
        description:
          "Hand a coding task to the Claude Code harness, which works in this conversation's " +
          "sandbox with its own read/edit/bash tools and keeps context across calls. Prefer for " +
          "deep refactors or nuanced code review; use pi for quick edits and plain bash for " +
          "one-off commands. The repo state is shared with bash and pi.",
        inputSchema: z.object({
          task: z.string().min(1).describe("The coding task, with enough context to act on."),
        }),
        execute: ({ task }, { toolCallId }) =>
          harnessToolStep({ conversationId, kind: "claude", task, toolCallId }),
      }),
    }),

    /** Trivial tool so the mock can force a second model step (steer test). */
    note: tool({
      description: "Record a note to yourself and continue.",
      inputSchema: z.object({ note: z.string().max(2_000) }),
      execute: async ({ note }) => `noted: ${note}`,
    }),
  };
}
