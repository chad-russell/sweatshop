import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { db } from "../db";
import { createMachine, createRun, getRun } from "../db/machines";
import { recordPRProposal, getPRProposal } from "../db/pr-proposals";
import { gitCredentials, machineStageRuns, projectRepos, projects } from "../db/schema";
import { runMachine } from "../workflows/machines/run-machine";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0034 Phase A: the publish stage — the deterministic executor after the
 * human gate's approval. Opens the run's pending proposal through a
 * local forgejo stub, refuses protected branches, and parks when no
 * proposal exists. The sandbox push is skipped under
 * SWEATSHOP_PUBLISH_MOCK (double-gated on NODE_ENV=test) — the push
 * itself is plain `git push` through the binding's handle.
 */

async function waitFor(what: () => Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await what()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const PUBLISH_DEF = {
  workspace: "project",
  start: "publish",
  stages: {
    publish: { kind: "publish", title: "Publish", next: [] },
  },
};

describe("publish stage (0034 A)", () => {
  let executor: WorkflowExecutor;
  const requests: { path: string }[] = [];
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    executor = await startWorkflowExecutor();
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests.push({ path: req.url ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: "http://git.test/chad/r/pulls/9", number: 9 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as import("node:net").AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await executor?.close();
    server?.close();
    delete process.env.SWEATSHOP_PUBLISH_MOCK;
  });

  async function seed(): Promise<{ runId: string; projectId: string }> {
    const rand = Math.random().toString(36).slice(2, 8);
    const pid = `pubm-${rand}`;
    db().insert(projects).values({ id: pid, name: "Pub", createdAt: Date.now() }).run();
    db().insert(projectRepos).values({
      id: `${pid}/r`, projectId: pid, name: "r",
      url: `http://127.0.0.1:${port}/chad/r`, createdAt: Date.now(),
    }).run();
    db().insert(gitCredentials).values({
      id: `cred-${pid}`, kind: "forgejo", label: "t", username: "chad",
      secret: "s", baseUrl: `http://127.0.0.1:${port}`, createdAt: Date.now(),
    }).run();
    createMachine(db(), { id: `pub-m-${rand}`, name: "Pub machine", definition: PUBLISH_DEF });
    const run = createRun(db(), { machineId: `pub-m-${rand}`, prompt: "p", projectId: pid });
    return { runId: run.id, projectId: pid };
  }

  async function runIt(runId: string, projectId: string, definition = PUBLISH_DEF) {
    await start(runMachine, [
      {
        runId,
        definition: definition as never,
        prompt: "p",
        projectId,
        binding: { kind: "bound", sandboxId: "sbx_test", workDir: "/work/t", owner: true } as never,
      },
    ]);
    await waitFor(async () => getRun(db(), runId)?.status !== "running", `run ${runId} to settle`);
    return getRun(db(), runId);
  }

  it("opens the run's approved proposal and records it in the visit outcome", async () => {
    process.env.SWEATSHOP_PUBLISH_MOCK = "1";
    const { runId, projectId } = await seed();
    const proposalId = `prp_pub_${Math.random().toString(36).slice(2, 8)}`;
    recordPRProposal(db(), {
      id: proposalId, runId, projectId, repo: "r", head: "feat/x",
      title: "Pub test", summary: "Open a pull request on \"r\": Pub test\nfeat/x → main",
    });

    const before = requests.length;
    const run = await runIt(runId, projectId);
    expect(run?.status).toBe("completed");
    expect(requests.slice(before).map((r) => r.path)).toContain("/api/v1/repos/chad/r/pulls");

    const row = getPRProposal(db(), proposalId)!;
    expect(row.status).toBe("opened");
    expect(row.resultUrl).toContain("pulls/9");
    const stage = db().select().from(machineStageRuns).where(eq(machineStageRuns.runId, runId)).get();
    expect(stage?.outcome).toContain("[pr] opened #9");
  });

  it("refuses a protected branch even under the mock", async () => {
    process.env.SWEATSHOP_PUBLISH_MOCK = "1";
    const { runId, projectId } = await seed();
    const proposalId = `prp_prot_${Math.random().toString(36).slice(2, 8)}`;
    recordPRProposal(db(), {
      id: proposalId, runId, projectId, repo: "r", head: "main",
      title: "Nope", summary: "s",
    });

    const before = requests.length;
    const run = await runIt(runId, projectId);
    expect(run?.status).toBe("needs-attention");
    expect(run?.error).toContain("protected branch");
    expect(requests.length).toBe(before);
    expect(getPRProposal(db(), proposalId)?.status).toBe("failed");
  });

  it("parks when there is no pending proposal", async () => {
    process.env.SWEATSHOP_PUBLISH_MOCK = "1";
    const { runId, projectId } = await seed();
    const run = await runIt(runId, projectId);
    expect(run?.status).toBe("needs-attention");
    expect(run?.error).toContain("no pending PR proposal");
  });
});
