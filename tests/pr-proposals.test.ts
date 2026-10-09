import { describe, expect, it } from "vitest";
import { db } from "../db";
import { createMachine, createRun } from "../db/machines";
import {
  getPRProposal,
  pendingRunProposal,
  recordPRProposal,
  resolvePRProposal,
} from "../db/pr-proposals";

/**
 * 0034 Phase A: the run-scoped pr_proposals store — the durable handoff
 * between a stage's propose_pr, the human gate that shows it, and the
 * publish stage that resolves it.
 */

const rand = Math.random().toString(36).slice(2, 8);

async function seedRun(): Promise<string> {
  const runRand = Math.random().toString(36).slice(2, 8);
  createMachine(db(), {
    id: `prp-m-${runRand}`,
    name: "PRP",
    definition: {
      workspace: "none",
      start: "draft",
      stages: { draft: { kind: "human", title: "D", instructions: "d", next: [] } },
    },
  });
  return createRun(db(), { machineId: `prp-m-${runRand}`, prompt: "p" }).id;
}

describe("pr_proposals store", () => {
  it("records idempotently and resolves first-write-wins", async () => {
    const runId = await seedRun();
    const base = { runId, projectId: "p", repo: "r", head: "feat/x", title: "T", summary: "s" };

    const first = recordPRProposal(db(), { ...base, id: `prp_a_${rand}` });
    expect(first.status).toBe("pending");
    expect(recordPRProposal(db(), { ...base, id: `prp_a_${rand}` }).id).toBe(first.id);

    expect(resolvePRProposal(db(), first.id, { status: "opened", url: "http://x/1", number: 1 })).toBe(true);
    expect(resolvePRProposal(db(), first.id, { status: "denied" })).toBe(false);
    const row = getPRProposal(db(), first.id)!;
    expect(row.status).toBe("opened");
    expect(row.resultUrl).toBe("http://x/1");
    expect(pendingRunProposal(db(), runId)).toBeNull();
  });

  it("pendingRunProposal returns the newest unresolved row (re-propose supersedes)", async () => {
    const runId = await seedRun();
    const base = { runId, projectId: "p", repo: "r", head: "feat/y", title: "T", summary: "s" };
    const denied = recordPRProposal(db(), { ...base, id: `prp_b1_${rand}` });
    resolvePRProposal(db(), denied.id, { status: "denied", comment: "not yet" });
    const pending = recordPRProposal(db(), { ...base, id: `prp_b2_${rand}` });

    const latest = pendingRunProposal(db(), runId);
    expect(latest?.id).toBe(pending.id);
    resolvePRProposal(db(), pending.id, { status: "failed", error: "push failed" });
    expect(pendingRunProposal(db(), runId)).toBeNull();
  });
});
