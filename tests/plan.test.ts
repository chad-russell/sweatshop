import { beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession, ModelMessage, UIMessage } from "ai";
import { db } from "../db";
import { ensureConversation, listPendingInputs, recordPendingInput } from "../db/chat";
import { loadPendingRequests } from "../db/attention";
import { getPlanRow, planState } from "../db/plans";
import { projects } from "../db/schema";
import { answerPendingWithText } from "../lib/chat/answer-pending";
import {
  acceptPlanApproved,
  acceptPlanPreview,
  approvePlan,
  planCallIds,
  presentPlan,
  type ApprovePlanDeps,
} from "../lib/agent/tools/plan";
import { derivePhase, diffLines, parseChecklist, phaseEvents, planHistory, type PlanSnapshot } from "../lib/plan";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0041 — plan files: the pure derivations (checklist, line diff, phase),
 * the review row lifecycle (open → supersede → approve, stale refused),
 * present_plan against a fake sandbox, and the card's approve path
 * (accept_plan answered directly, else a wake).
 */

/** A sandbox whose only content is a scripted PLAN.md per work root. */
class PlanSandbox implements SandboxProvider {
  readonly kind = "fake";
  files = new Map<string, string>();
  async create(): Promise<SandboxHandle> {
    return this.attach("plan-sbx");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        const path = /'([^']+)'/.exec(command)?.[1] ?? "";
        const body = this.files.get(path);
        if (command.startsWith("stat")) {
          return { exitCode: 0, stdout: body === undefined ? "-1\n" : `${Buffer.byteLength(body)}\n`, stderr: "" };
        }
        if (command.startsWith("cat")) {
          return body === undefined ? { exitCode: 1, stdout: "", stderr: "no" } : { exitCode: 0, stdout: body, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop() {}
  async resume() {}
  async destroy() {}
}

const PLAN_V1 = "# Plan\n\n- [ ] add the column\n- [ ] wire the card\n";
const PLAN_V2 = "# Plan\n\n- [x] add the column\n- [ ] wire the card\n- [ ] tests\n";

/** A tool-result message carrying a present_plan snapshot (as persisted). */
function resultMessage(toolCallId: string, snapshot: PlanSnapshot): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName: "present_plan", output: { type: "json", value: snapshot as never } }],
  } as ModelMessage;
}

describe("0041 plan derivations (pure)", () => {
  it("counts task-list items, ignoring plain bullets", () => {
    expect(parseChecklist(PLAN_V2)).toEqual({ done: 1, total: 3 });
    expect(parseChecklist("- a\n* [X] b\n  + [ ] c\n[ ] not a list")).toEqual({ done: 1, total: 2 });
    expect(parseChecklist("")).toEqual({ done: 0, total: 0 });
  });

  it("diffs lines by LCS", () => {
    const d = diffLines(PLAN_V1, PLAN_V2);
    expect(d.filter((l) => l.op === "del").map((l) => l.text)).toEqual(["- [ ] add the column"]);
    expect(d.filter((l) => l.op === "add").map((l) => l.text)).toEqual(["- [x] add the column", "- [ ] tests"]);
    expect(d.filter((l) => l.op === "same").map((l) => l.text)).toContain("- [ ] wire the card");
    expect(diffLines("a\nb", "a\nb").every((l) => l.op === "same")).toBe(true);
    expect(diffLines("", "x")).toEqual([
      { op: "del", text: "" },
      { op: "add", text: "x" },
    ]);
  });

  it("derives the phase: review → building m/n → PR needs you → PR open", () => {
    const plan = (version: number, status: "review" | "progress", done = 0, total = 3) =>
      ({ type: "plan", version, status, checklist: { done, total } }) as const;
    expect(derivePhase([])).toBeNull();
    expect(derivePhase([plan(1, "review"), plan(2, "review")])?.label).toBe("Plan v2 · needs you");
    expect(derivePhase([plan(2, "review"), { type: "plan-approved" }])?.label).toBe("Building 0/3");
    expect(derivePhase([plan(2, "review"), { type: "plan-approved" }, plan(3, "progress", 2)])?.label).toBe("Building 2/3");
    // reapprove reopens the review
    expect(derivePhase([plan(2, "review"), { type: "plan-approved" }, plan(3, "review")])?.label).toBe("Plan v3 · needs you");
    const pr = [plan(1, "review"), { type: "plan-approved" } as const, { type: "pr-pending" } as const];
    expect(derivePhase(pr)?.label).toBe("PR · needs you");
    expect(derivePhase([...pr, { type: "pr-not-opened" }])?.label).toBe("Building 0/3");
    expect(derivePhase([...pr, { type: "pr-open", url: "http://x/pulls/1" }])).toEqual({
      label: "PR open",
      tone: "ok",
      url: "http://x/pulls/1",
    });
  });

  it("reads phase events and plan history off a UI transcript", () => {
    const snap = (version: number, markdown: string, status: "review" | "progress" = "review"): PlanSnapshot => ({
      ok: true,
      version,
      markdown,
      checklist: parseChecklist(markdown),
      status,
      next: "",
    });
    const msgs: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-present_plan", toolCallId: "p1", state: "output-available", input: {}, output: snap(1, PLAN_V1) },
          { type: "tool-present_plan", toolCallId: "p2", state: "output-available", input: {}, output: snap(2, PLAN_V2) },
        ] as UIMessage["parts"],
      },
    ];
    let h = planHistory(msgs);
    expect(h.latestId).toBe("p2");
    expect(h.openReviewId).toBe("p2");
    expect(h.previous.get("p2")).toEqual({ version: 1, markdown: PLAN_V1 });
    expect(h.previous.has("p1")).toBe(false);
    expect(derivePhase(phaseEvents(msgs))?.label).toBe("Plan v2 · needs you");

    msgs.push({
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "[plan v2 approved]" }],
      metadata: { runEvent: { kind: "plan", id: "p2", status: "approved" } },
    });
    h = planHistory(msgs);
    expect(h.openReviewId).toBeNull();
    expect(derivePhase(phaseEvents(msgs))?.label).toBe("Building 1/3");
  });

  it("finds present_plan snapshots in persisted model messages", () => {
    const s: PlanSnapshot = { ok: true, version: 1, markdown: "x", checklist: { done: 0, total: 0 }, status: "review", next: "" };
    expect(planCallIds([resultMessage("p1", s), { role: "user", content: "hi" }])).toEqual(["p1"]);
    expect(
      planCallIds([
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "x", toolName: "present_plan", output: { type: "json", value: { ok: false } } }],
        } as ModelMessage,
      ]),
    ).toEqual([]);
  });
});

describe("0041 plan reviews (store + cores)", () => {
  const sandbox = new PlanSandbox();
  let n = 0;
  const conv = () => {
    const id = `c_plan_${++n}_${Math.random().toString(36).slice(2, 6)}`;
    ensureConversation(db(), id, "p_plan");
    return id;
  };
  const write = (id: string, body: string) => sandbox.files.set(`/work/${id}/PLAN.md`, body);

  beforeAll(() => {
    db().insert(projects).values({ id: "p_plan", name: "Plan", createdAt: 0 }).onConflictDoNothing().run();
  });

  it("refuses a missing plan file, value-shaped", async () => {
    const id = conv();
    const res = await presentPlan(id, "t0", {}, [], sandbox);
    expect(res).toMatchObject({ ok: false, code: "no-plan" });
    expect(planState(db(), id).kind).toBe("none");
  });

  it("present opens a review; a newer version supersedes it; versions count prior snapshots", async () => {
    const id = conv();
    write(id, PLAN_V1);
    const v1 = await presentPlan(id, "t1", { note: "first cut" }, [], sandbox);
    expect(v1).toMatchObject({ ok: true, version: 1, status: "review", checklist: { done: 0, total: 2 }, note: "first cut" });
    expect(planState(db(), id)).toMatchObject({ kind: "review", row: { id: "t1" } });
    // Inbox shows it as a plan request with the snapshot
    const req = loadPendingRequests(db(), [id]).get(id)?.[0];
    expect(req).toMatchObject({ kind: "plan", toolName: "present_plan", options: [], plan: { version: 1, note: "first cut" } });

    write(id, PLAN_V2);
    const v2 = await presentPlan(id, "t2", {}, [resultMessage("t1", v1 as PlanSnapshot)], sandbox);
    expect(v2).toMatchObject({ ok: true, version: 2, status: "review" });
    expect(listPendingInputs(db(), id).map((p) => p.id)).toEqual(["t2"]);
    expect(getPlanRow(db(), "t1")?.answer).toMatchObject({ superseded: true });
  });

  it("typing never answers a plan review — only real suspensions", async () => {
    const id = conv();
    write(id, PLAN_V1);
    await presentPlan(id, "t3", {}, [], sandbox);
    expect(await answerPendingWithText(id, "why not sqlite?", { resume: async () => undefined })).toBeNull();
    expect(planState(db(), id).kind).toBe("review");
  });

  it("the card approves the open review once and wakes; stale or repeated approvals are refused", async () => {
    const id = conv();
    write(id, PLAN_V1);
    const v1 = (await presentPlan(id, "t4", {}, [], sandbox)) as PlanSnapshot;
    write(id, PLAN_V2);
    await presentPlan(id, "t5", {}, [resultMessage("t4", v1)], sandbox);

    const woke: unknown[] = [];
    const deps: ApprovePlanDeps = {
      resume: async () => {
        throw new Error("no accept_plan waiting");
      },
      wake: async (...args) => {
        woke.push(args);
      },
    };
    expect(await approvePlan("t4", undefined, deps)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("v2") });
    expect(await approvePlan("nope", undefined, deps)).toMatchObject({ ok: false, status: 404 });
    expect(await approvePlan("t5", "ship it", deps)).toEqual({ ok: true, version: 2, delivered: "wake" });
    expect(woke).toEqual([[id, 2, "t5", "ship it"]]);
    expect(planState(db(), id)).toMatchObject({ kind: "approved", row: { id: "t5" } });
    expect(await approvePlan("t5", undefined, deps)).toMatchObject({ ok: false, status: 409, error: "this plan is already approved" });
    expect(woke).toHaveLength(1);

    // After approval a present is progress — no new review, nothing pending.
    write(id, PLAN_V2.replace("- [ ] wire", "- [x] wire"));
    const p = await presentPlan(id, "t6", {}, [], sandbox);
    expect(p).toMatchObject({ ok: true, status: "progress", checklist: { done: 2, total: 3 } });
    expect(listPendingInputs(db(), id)).toEqual([]);
    // ...unless the agent asks to reapprove.
    const r = await presentPlan(id, "t7", { reapprove: true }, [], sandbox);
    expect(r).toMatchObject({ status: "review" });
    expect(planState(db(), id)).toMatchObject({ kind: "review", row: { id: "t7" } });
  });

  it("the card's approve answers a waiting accept_plan instead of waking", async () => {
    const id = conv();
    write(id, PLAN_V1);
    await presentPlan(id, "t8", {}, [], sandbox);
    const preview = acceptPlanPreview(id);
    expect(preview).toMatchObject({ ok: true, rowId: "t8", summary: "Approve plan v1?" });
    if (!preview.ok) throw new Error("unreachable");
    recordPendingInput(db(), { id: "acc1", conversationId: id, kind: "approval", question: preview.summary, card: preview.card });
    // accept_plan's approval carries the plan card in the Inbox
    const reqs = loadPendingRequests(db(), [id]).get(id) ?? [];
    expect(reqs.find((r) => r.requestId === "acc1")).toMatchObject({ kind: "tool-approval", toolName: "accept_plan", plan: { version: 1 } });

    const resumed: string[] = [];
    const res = await approvePlan("t8", undefined, {
      resume: async (token) => {
        resumed.push(token);
      },
      wake: async () => {
        throw new Error("must not wake");
      },
    });
    expect(res).toEqual({ ok: true, version: 1, delivered: "accept_plan" });
    expect(resumed).toEqual(["acc1"]);
    expect(listPendingInputs(db(), id)).toEqual([]);
    // the tool's own approved path is then idempotent
    expect(acceptPlanApproved("t8")).toMatchObject({ approved: true, version: 1 });
  });

  it("accept_plan refuses without an open review", async () => {
    const id = conv();
    expect(acceptPlanPreview(id)).toMatchObject({ ok: false, code: "no-review" });
  });

  it("the plan tools come with the sandbox, never without", () => {
    const names = (hasSandbox: boolean) => Object.keys(buildChatTools("c_x", { hasSandbox, hasProject: true }));
    expect(names(true)).toEqual(expect.arrayContaining(["present_plan", "accept_plan"]));
    expect(names(false)).not.toContain("present_plan");
    expect(names(false)).not.toContain("accept_plan");
  });
});
