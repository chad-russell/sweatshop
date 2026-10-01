import { WorkflowAgent } from "@ai-sdk/workflow";
import { eq } from "drizzle-orm";
import { tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { z } from "zod";
import { defineHook } from "workflow";
import { db } from "@/db";
import { gitCredentials, projectRepos, ticketRuns } from "@/db/schema";
import { glmFlash } from "@/lib/model";
import { resolveCredential } from "@/lib/git-hosts/index";
import { GIT_HOSTS } from "@/lib/git-hosts/hosts";

/**
 * 0004 Path B — run_ticket: a raw Workflow SDK pipeline that provisions
 * a project sandbox, runs plan → (approval gate) → implement → QA →
 * push+PR as WorkflowAgent phases sharing one container, and tracks
 * status in ticket_runs for the UI. Triggered directly by a button or
 * API — no agent session involved.
 *
 * Workflow-transform rule enforced at build time: the body may only
 * orchestrate; every Node-touching operation (docker, sqlite, fs) lives
 * in a `"use step"` function, with Node imports made inside steps.
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
  const { attachSandbox } = await import("@/lib/sandboxes/provision");
  await attachSandbox(containerName).remove();
}

async function openPR(
  projectId: string,
  head: string,
  title: string,
  body: string,
): Promise<{ url: string; repo: string }> {
  "use step";
  const repos = db()
    .select()
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all();
  if (repos.length === 0) throw new Error(`project "${projectId}" has no repos`);
  const credentials = db().select().from(gitCredentials).all();

  // The repo whose remote host has a matching credential — repos without
  // one (e.g. a public github repo with no github token seeded) can't be
  // PR'd.
  let target: { url: string; name: string } | null = null;
  let host: (typeof GIT_HOSTS)[number] | undefined;
  let credential: (typeof credentials)[number] | undefined;
  for (const repo of repos) {
    const resolved = resolveCredential(repo.url, credentials, GIT_HOSTS);
    if (resolved) {
      target = repo;
      host = resolved.host;
      credential = resolved.credential;
      break;
    }
  }
  if (!target || !host || !credential) {
    throw new Error(
      `no git credential matches any repo host of project "${projectId}" ` +
        `(repos: ${repos.map((r) => r.url).join(", ")})`,
    );
  }

  const result = await host.createPR(credential, {
    remoteUrl: target.url,
    head,
    title,
    body,
  });
  return { url: result.url, repo: target.name };
}

// --- phase agents (run inside steps; Node imports stay here) -------------

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

async function phase(
  containerName: string,
  instructions: string,
  message: string,
): Promise<string> {
  "use step";
  const [{ toSandboxSession }, { attachSandbox }] = await Promise.all([
    import("@/lib/sandboxes/ai-sdk-adapter"),
    import("@/lib/sandboxes/provision"),
  ]);
  const session = toSandboxSession(attachSandbox(containerName));
  const agent = new WorkflowAgent({
    model: glmFlash(),
    instructions,
    // ai@7.0.x (pinned under eve 0.67.2) vs @ai-sdk/workflow Tool
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

// --- the workflow (pure orchestration) ------------------------------------

export async function runTicketWorkflow(input: RunTicketInput) {
  "use workflow";
  const { ticketId, projectId, ticket } = input;

  await record(ticketId, "planning");
  const containerName = await provision(input);

  try {
    const planText = await phase(
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
    await phase(
      containerName,
      "You are the implementation phase of a ticket pipeline. You have a " +
        "bash tool in a sandbox with the project's repos at /workspace. " +
        "Follow the approved plan exactly: create the branch, make the " +
        "changes, commit with clear messages. Do NOT push. Keep going " +
        "until the work is complete.",
      `Approved plan:\n\n${planText}\n\nTicket:\n${ticket}\n\nBranch: ${branch}`,
    );

    await record(ticketId, "qa");
    const qaText = await phase(
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
    await phase(
      containerName,
      "You are the final phase of a ticket pipeline. Push the current " +
        "branch to origin with bash (credentials are installed).",
      `Push branch ${branch} to origin.`,
    );

    const pr = await openPR(
      projectId,
      branch,
      `Ticket run ${ticketId}: ${ticket.split("\n")[0]!.slice(0, 60)}`,
      `Automated ticket run.\n\nTicket:\n\n${ticket}`,
    );
    await record(ticketId, "completed", { prUrl: pr.url });
    return { prUrl: pr.url, reason: "completed" };
  } catch (err) {
    await record(ticketId, "failed", {
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await cleanupContainer(containerName);
  }
}
