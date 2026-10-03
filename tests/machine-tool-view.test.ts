import { describe, expect, it } from "vitest";
import {
  describeOps,
  execOf,
  failureOf,
  inspectOf,
  machineList,
  machineResult,
  runStarted,
  transitionOf,
} from "../lib/machine-tool-view";

const def = {
  workspace: "project",
  start: "plan",
  stages: {
    plan: { kind: "harness", harness: "pi", title: "Plan", next: [{ to: "approve" }] },
    approve: { kind: "human", title: "Approve", next: [{ to: "build" }, { to: "end", when: "reject" }] },
    build: { kind: "harness", harness: "claude", title: "Build", next: [{ to: "end" }] },
    orphan: { kind: "agent", title: "Orphan", next: [] },
  },
};

describe("failureOf", () => {
  it("is undefined for success and unknown shapes", () => {
    expect(failureOf({ ok: true })).toBeUndefined();
    expect(failureOf("text")).toBeUndefined();
    expect(failureOf(undefined)).toBeUndefined();
  });
  it("flattens issues by element", () => {
    const f = failureOf({
      ok: false,
      code: "invalid",
      message: "nope",
      issues: { stages: { plan: ["needs a next"] }, transitions: { "a->b": ["dup"] }, general: ["no start"] },
    });
    expect(f).toEqual({ code: "invalid", message: "nope", issues: ["plan: needs a next", "a->b: dup", "no start"] });
  });
});

describe("describeOps", () => {
  it("renders each op kind as a line", () => {
    const lines = describeOps([
      { op: "add_stage", kind: "harness", title: "Lint", id: "lint" },
      { op: "update_stage", stage: "lint", patch: { harness: "pi", maxVisits: 3, model: null, instructions: "long" } },
      { op: "connect", source: "implement", target: "lint", when: "tests pass" },
      { op: "disconnect", source: "a", target: "b" },
      { op: "remove_stage", stage: "old" },
      { op: "rename_stage", from: "x", to: "y" },
      { op: "set_start", stage: "plan" },
      { op: "mystery" },
    ]);
    expect(lines.map((l) => `${l.tone}|${l.text}|${l.detail ?? ""}`)).toEqual([
      "add|Add harness stage Lint|",
      "change|Update lint|harness → pi, maxVisits → 3, model cleared, instructions",
      "link|implement → lint|tests pass",
      "unlink|a ⇢ b|",
      "remove|Remove stage old|",
      "change|Rename x → y|",
      "change|Start at plan|",
      "change|mystery|",
    ]);
  });
  it("tolerates garbage", () => {
    expect(describeOps(undefined)).toEqual([]);
    expect(describeOps([null, 7])[0]!.text).toBe("edit");
  });
});

describe("machines", () => {
  it("walks the flow from the start stage, appending unreachable stages", () => {
    const m = machineResult({ ok: true, machine: { id: "t", name: "Ticket", description: "d", workspace: "project", version: 2, stages: 4, definition: def } })!;
    expect(m.flow.map((s) => s.id)).toEqual(["plan", "approve", "build", "orphan"]);
    expect(m.flow[0]).toMatchObject({ harness: "pi", next: ["approve"] });
    expect(m).toMatchObject({ name: "Ticket", version: 2, stageCount: 4 });
  });
  it("summaries without a definition have no flow", () => {
    const [m] = machineList({ ok: true, machines: [{ id: "a", name: "A", description: null, workspace: "none", version: 1, stages: 3 }] });
    expect(m).toMatchObject({ id: "a", stageCount: 3, flow: [] });
  });
  it("does not treat a failure as a machine", () => {
    expect(machineResult({ ok: false, code: "not-found", message: "x" })).toBeUndefined();
  });
});

describe("runs and inspect", () => {
  it("reads a started run", () => {
    expect(runStarted({ runId: "mr_1", url: "/r/mr_1", sandbox: "inherited" })).toEqual({ runId: "mr_1", url: "/r/mr_1", sandbox: "inherited" });
    expect(runStarted({ ok: false })).toBeUndefined();
  });
  it("normalises a run inspect with visits", () => {
    const v = inspectOf({
      kind: "run", id: "mr_1", machine: "Ticket", status: "completed", prompt: "p",
      sandbox: { sandboxId: "sbx_1" },
      visits: [{ seq: 0, stage: "plan", kind: "harness", harness: "pi", status: "completed", to: "approve", outcome: "ok" }],
    })!;
    expect(v).toMatchObject({ kind: "run", machine: "Ticket", sandbox: "sbx_1" });
    expect(v.visits[0]).toMatchObject({ stage: "plan", harness: "pi", to: "approve" });
  });
  it("normalises a chat inspect with harness runs", () => {
    const v = inspectOf({ kind: "chat", id: "c_1", title: "T", busy: false, totalMessages: 6, harness: { runs: [{ harness: "pi", status: "completed", toolCalls: 3 }] }, sandbox: { state: "none" } })!;
    expect(v).toMatchObject({ messages: 6, sandbox: "none" });
    expect(v.harnessRuns).toEqual([{ harness: "pi", status: "completed", toolCalls: 3 }]);
  });
  it("reads sandbox_exec output", () => {
    expect(execOf({ sandboxId: "sbx_1", workDir: "/work/x", exitCode: 0, stdout: "a\n", stderr: "" })).toMatchObject({ exitCode: 0, stdout: "a\n" });
    expect(execOf({ nope: 1 })).toBeUndefined();
  });
  it("reads a transition from output, falling back to input", () => {
    expect(transitionOf({ to: "verify", reason: "tests pass" }, { ok: true, to: "verify", note: "next stage: verify" })).toEqual({ to: "verify", reason: "tests pass", ok: true, note: "next stage: verify" });
    expect(transitionOf({ to: "x" }, undefined)).toMatchObject({ to: "x", ok: true });
  });
});
