import { WorkflowAgent } from "@ai-sdk/workflow";
import { eq } from "drizzle-orm";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { defineHook } from "workflow";
import { db } from "@/db";
import { gitCredentials, projectRepos, ticketRuns } from "@/db/schema";
import { glmFlash } from "@/lib/model";
import { toSandboxSession } from "@/lib/sandboxes/ai-sdk-adapter";
import { attachSandbox } from "@/lib/sandboxes/provision";
import { GIT_HOSTS, loadProjectPlan } from "@/lib/sandboxes/setup";
import { httpsRemote, resolveCredential } from "@/lib/git-hosts/index";

/**
 * 0004 Path B — run_ticket: a raw Workflow SDK pipeline that provisions
 * a project sandbox, runs plan → (approval gate) → implement → QA →
 * push+PR as WorkflowAgent phases sharing one container, and tracks
 * status in ticket_runs for the UI. Triggered directly by a button or
 * API — no agent session involved.
 */

export const planApprovalHook = defineHook({
  schema: z.object({
    approved: z.boolean(),
    comment: z.string().optional(),
  }),
});

export interface RunTicketInput {
  ticketId: string;
  projectId: string;
  ticket: string;
}

// --- steps (side effects; replay-safe via recorded results) -------------

async function provision(input: RunTicketInput): Promise<string> {
  "use step";
  // Import lazily so the bundler keeps docker-using code out of the
  // deterministic body evaluation path.
  const { provisionProjectSandbox } = await import("@/lib/sandboxes/provision");
  const sb = await provisionProjectSandbox(input.projectId);
  return sb.containerName;
}

async function record(
  ticketId: string,
  status: string,
  extra: Partial<{ detail: string; branch: string; prUrl: string }> = {},
) {
  "use step";
  db()
    .update(ticketRuns)
    .set({ status, updatedAt: Date.now(), ...extra })
    .where(eq(ticketRuns.id, ticketId))
    .run();
}

async function cleanupContainer(containerName: string) {
  "use step";
  await attachSandbox(containerName).remove();
}

async function openPR(
  projectId: string,
  repoName: string,
  head: string,
  title: string,
  body: string,
): Promise<string> {
  "use step";
  const repos = db()
    .select()
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all();
  const repo = repos.find((r) => r.name === repoName);
  if (!repo) throw new Error(`no repo "${repoName}" in project "${projectId}"`);
  const credentials = db().select().from(gitCredentials).all();
  const resolved = resolveCredential(httpsRemote(repo.url), credentials, GIT_HOSTS);
  if (!resolved) throw new Error(`no credential matches the host of ${repo.url}`);
  const result = await resolved.host.createPR(resolved.credential, {
    remoteUrl: repo.url,
    head,
    title,
    body,
  });
  return result.url;
}

// --- phase agents ---------------------------------------------------------

const bashTool = tool({
  description:
    "Run a shell command in the project sandbox (the project's repos are " +
    "cloned under /workspace/<repo>). Returns exitCode/stdout/stderr.",
  inputSchema: z.object({ command: z.string().min(1) }),
  execute: async (
    { command },
    options: ToolExecutionOptions<unknown>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const sandbox = options.experimental_sandbox as
      | { run(o: { command: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
      | undefined;
    if (!sandbox) throw new Error("no sandbox available to this agent");
    return sandbox.run({ command });
  },
});

async function runPhase(
  containerName: string,
  instructions: string,
  message: string,
): Promise<string> {
  const session = toSandboxSession(attachSandbox(containerName));
  const agent = new WorkflowAgent({
    model: glmFlash(),
    instructions,
    // ai@7.0.x (pinned under eve 0.67.2) vs @ai-sdk/workflow@2.0.54 Tool
    // generics drift type-level only; the runtime shape is identical.
    tools: { bash: bashTool } as unknown as ToolSet,
    experimental_sandbox: session,
  });
  const result = await agent.stream({
    messages: [{ role: "user", content: message }],
  });
  // Final assistant text = the phase's reply.
  for (let i = result.messages.length - 1; i >= 0; i -= 1) {
    const m = result.messages[i]!;
    if (m.role === "assistant") {
      return typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n");
    }
  }
  return "";
}

// --- the workflow ---------------------------------------------------------

export async function runTicketWorkflow(input: RunTicketInput) {
  "use workflow";
  const { ticketId, projectId, ticket } = input;
  const plan = loadProjectPlan(projectId);
  if (!plan) throw new Error(`unknown project "${projectId}"`);

  await record(ticketId, "planning");
  const containerName = await provision(input);

  try {
    const planText = await runPhase(
      containerName,
      "You are the planning phase of a ticket pipeline. Inspect the repos " +
        "under /workspace with bash. Produce a concise implementation plan. " +
        "The FIRST line of your reply must be exactly `BRANCH: <branch-name>` " +
        "naming a new git branch for the work. Then the plan in markdown.",
      `Ticket:\n\n${ticket}`,
    );
    const branch =
      planText.match(/^BRANCH:\s*(\S+)/m)?.[1] ??
      `ticket/${ticketId.slice(0, 8)}`;

    await record(ticketId, "awaiting-approval", {
      detail: planText.replace(/^BRANCH:.*\n?/m, "").trim(),
      branch,
    });

    // Approval gate — the workflow suspends (no compute) until the UI
    // resumes the hook (token = ticketId).
    const hook = planApprovalHook.create({ token: ticketId });
    const { approved, comment } = await hook;
    if (!approved) {
      await record(ticketId, "rejected", { detail: comment });
      return { prUrl: null, reason: "rejected" };
    }

    await record(ticketId, "implementing");
    await runPhase(
      containerName,
      "You are the implementation phase of a ticket pipeline. You have a " +
        "bash tool in a sandbox with the project's repos at /workspace. " +
        "Follow the approved plan exactly: create the branch, make the " +
        "changes, commit with clear messages. Do NOT push. Keep going " +
        "until the work is complete.",
      `Approved plan:\n\n${planText}\n\nTicket:\n${ticket}\n\nBranch: ${branch}`,
    );

    await record(ticketId, "qa");
    const qaText = await runPhase(
      containerName,
      "You are the QA phase of a ticket pipeline. Verify the work on the " +
        "current branch in /workspace (run any available tests/build; at " +
        "minimum confirm the changes are present and the repo is intact). " +
        "Reply PASS or FAIL followed by one short paragraph of findings.",
      `Verify the implementation of this ticket on branch ${branch}:\n${ticket}`,
    );
    if (!/^PASS/m.test(qaText)) {
      await record(ticketId, "failed", { detail: `QA failed: ${qaText.slice(0, 2000)}` });
      return { prUrl: null, reason: "qa-failed" };
    }

    await record(ticketId, "finishing");
    await runPhase(
      containerName,
      "You are the final phase of a ticket pipeline. Push the current " +
        "branch to origin with bash (credentials are installed).",
      `Push branch ${branch} to origin.`,
    );

    const prUrl = await openPR(
      projectId,
      plan.repos[0]!.name,
      branch,
      `Ticket run ${ticketId}: ${ticket.split("\n")[0]!.slice(0, 60)}`,
      `Automated ticket run.\n\nTicket:\n\n${ticket}`,
    );
    await record(ticketId, "completed", { prUrl });
    return { prUrl, reason: "completed" };
  } catch (err) {
    await record(ticketId, "failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await cleanupContainer(containerName);
  }
}
