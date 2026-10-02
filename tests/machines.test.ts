import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { projects } from "../db/schema";
import {
  beginStageRun,
  createMachine,
  createRun,
  deleteMachine,
  getRun,
  listStageRuns,
  listWaitingGates,
  parseVisitToken,
  updateMachine,
  updateRun,
  updateStageRun,
  visitToken,
} from "../db/machines";
import { parseDefinition, type MachineDefinition } from "../lib/machines/definition";
import { POST as createRoute, GET as listRoute } from "../app/api/machines/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "../app/api/machines/[id]/route";

const tdb = openDb(process.env.SWEATSHOP_DB!);
tdb.insert(projects).values({ id: "mp", name: "mp", createdAt: 1 }).onConflictDoNothing().run();

const coding: MachineDefinition = {
  workspace: "project",
  start: "plan",
  stages: {
    plan: { kind: "harness", harness: "pi", title: "Plan", instructions: "plan", next: [{ to: "gate" }] },
    gate: {
      kind: "human",
      title: "Approve",
      instructions: "ok?",
      next: [{ to: "build", when: "approve" }, { to: "end", when: "reject" }],
    },
    build: { kind: "harness", harness: "claude", title: "Build", instructions: "build", next: [] },
  },
};

const thinking: MachineDefinition = {
  workspace: "none",
  start: "draft",
  stages: {
    draft: { kind: "agent", title: "Draft", instructions: "draft", next: [] },
  },
};

describe("machine definitions", () => {
  it("accepts well-formed machines", () => {
    expect(parseDefinition(coding).ok).toBe(true);
    expect(parseDefinition(thinking).ok).toBe(true);
  });

  it("rejects dangling references, duplicates, and harness without a project", () => {
    const bad = parseDefinition({
      workspace: "none",
      start: "nope",
      stages: {
        a: {
          kind: "harness",
          harness: "pi",
          title: "A",
          instructions: "",
          next: [{ to: "b" }, { to: "ghost" }, { to: "b" }],
        },
        b: { kind: "agent", title: "B", instructions: "", next: [] },
      },
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const text = bad.errors.join("\n");
    expect(text).toContain('start: start stage "nope" does not exist');
    expect(text).toContain('stage "ghost" does not exist');
    expect(text).toContain('duplicate transition to "b"');
    expect(text).toContain("harness stages need workspace: project");
  });

  it("reserves end as the terminal target", () => {
    const named = parseDefinition({
      workspace: "none",
      start: "end",
      stages: { end: { kind: "agent", title: "x", instructions: "", next: [] } },
    });
    expect(named.ok).toBe(false);
  });

  it("rejects unknown kinds and bad stage ids", () => {
    expect(parseDefinition({ workspace: "none", start: "A", stages: { A: { kind: "agent", title: "x", instructions: "", next: [] } } }).ok).toBe(false);
    expect(parseDefinition({ workspace: "none", start: "a", stages: { a: { kind: "robot", title: "x", instructions: "", next: [] } } }).ok).toBe(false);
  });
});

describe("machines store", () => {
  it("versions definition changes only", () => {
    const m = createMachine(tdb, { id: "store-a", name: " Ticket  flow ", definition: coding });
    expect(m.name).toBe("Ticket flow");
    expect(m.version).toBe(1);
    expect(updateMachine(tdb, m.id, { name: "Renamed" }).version).toBe(1);
    expect(updateMachine(tdb, m.id, { definition: coding }).version).toBe(1); // unchanged content
    const changed = { ...coding, stages: { ...coding.stages, plan: { ...coding.stages.plan!, title: "Plan it" } } };
    expect(updateMachine(tdb, m.id, { definition: changed }).version).toBe(2);
    expect(() => updateMachine(tdb, m.id, { definition: { workspace: "none" } })).toThrow(/invalid machine definition/);
  });

  it("binds a project only for project machines, and snapshots the definition", () => {
    createMachine(tdb, { id: "store-b", name: "B", definition: coding });
    createMachine(tdb, { id: "store-c", name: "C", definition: thinking });
    expect(() => createRun(tdb, { machineId: "store-b", prompt: "x" })).toThrow(/needs a project/);
    expect(() => createRun(tdb, { machineId: "store-b", prompt: "x", projectId: "ghost" })).toThrow(/not found/);
    expect(() => createRun(tdb, { machineId: "store-c", prompt: "x", projectId: "mp" })).toThrow(/does not use a project/);
    expect(() => createRun(tdb, { machineId: "store-c", prompt: "  " })).toThrow(/prompt is required/);

    const run = createRun(tdb, { machineId: "store-b", prompt: "fix it", projectId: "mp" });
    expect(run).toMatchObject({ status: "running", projectId: "mp", currentStage: "plan", machineVersion: 1 });

    // Editing or deleting the machine never touches the run's snapshot.
    updateMachine(tdb, "store-b", { definition: thinking });
    deleteMachine(tdb, "store-b");
    const after = getRun(tdb, run.id);
    expect(after.machineId).toBeNull();
    expect(after.definition.start).toBe("plan");
  });

  it("records idempotent stage visits and surfaces waiting gates", () => {
    createMachine(tdb, { id: "store-d", name: "D", definition: coding });
    const run = createRun(tdb, { machineId: "store-d", prompt: "go", projectId: "mp" });
    beginStageRun(tdb, { runId: run.id, seq: 0, stageId: "plan", kind: "harness", harness: "pi" });
    beginStageRun(tdb, { runId: run.id, seq: 0, stageId: "plan", kind: "harness", harness: "pi" });
    updateStageRun(tdb, run.id, 0, { status: "completed", transitionTo: "gate" });
    beginStageRun(tdb, { runId: run.id, seq: 1, stageId: "gate", kind: "human" });
    expect(listStageRuns(tdb, run.id).map((s) => [s.seq, s.status])).toEqual([[0, "completed"], [1, "waiting"]]);

    expect(listWaitingGates(tdb).some((g) => g.run.id === run.id)).toBe(false); // run not parked yet
    updateRun(tdb, run.id, { status: "waiting", currentStage: "gate" });
    expect(listWaitingGates(tdb).find((g) => g.run.id === run.id)?.stage.stageId).toBe("gate");

    const token = visitToken(run.id, 1);
    expect(parseVisitToken(token)).toEqual({ runId: run.id, seq: 1 });
    expect(parseVisitToken("nope:1")).toBeNull();
  });
});

describe("machines routes", () => {
  const json = (method: string, body: unknown) =>
    new Request("http://x", { method, body: JSON.stringify(body) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("creates, lists, validates, patches and deletes", async () => {
    const created = await createRoute(json("POST", { id: "route-a", name: "Route A", definition: thinking }));
    expect(created.status).toBe(201);
    expect((await createRoute(json("POST", { id: "route-a", name: "dup", definition: thinking }))).status).toBe(400);

    const invalid = await createRoute(json("POST", { name: "Bad", definition: { workspace: "none", start: "x", stages: {} } }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).details.length).toBeGreaterThan(0);

    const list = await (await listRoute()).json();
    expect(list.machines.some((m: { id: string }) => m.id === "route-a")).toBe(true);

    const patched = await patchRoute(json("PATCH", { description: "thinking" }), ctx("route-a"));
    expect((await patched.json()).machine.description).toBe("thinking");
    expect((await patchRoute(json("PATCH", { name: "x" }), ctx("ghost"))).status).toBe(404);
    expect((await deleteRoute(new Request("http://x"), ctx("route-a"))).status).toBe(200);
    expect((await deleteRoute(new Request("http://x"), ctx("route-a"))).status).toBe(404);
  });
});

describe("seed machines", () => {
  it("every seed definition validates", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = "lib/machines/seeds";
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const seed = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      const parsed = parseDefinition(seed.definition);
      expect(parsed.ok ? [] : parsed.errors, file).toEqual([]);
    }
  });
});

describe("briefs and transitions", async () => {
  const { buildBrief, resolveTransition, transitionGuide } = await import("../lib/machines/brief");
  const gate = coding.stages.gate!;
  const plan = coding.stages.plan!;
  const build = coding.stages.build!;

  it("resolves single, terminal, and branching transitions", () => {
    expect(resolveTransition(plan, null)).toBe("gate"); // one target: no choice needed
    expect(resolveTransition(plan, "build")).toBe("gate"); // proposal ignored
    expect(resolveTransition(build, null)).toBe("end"); // no next = end
    expect(resolveTransition(gate, "build")).toBe("build");
    expect(resolveTransition(gate, "end")).toBe("end");
    expect(resolveTransition(gate, null)).toBeNull(); // must choose
    expect(resolveTransition(gate, "plan")).toBeNull(); // not allowed
  });

  it("only guides branching stages", () => {
    expect(transitionGuide(plan)).toBeNull();
    expect(transitionGuide(gate)).toContain("`build` — approve");
  });

  it("carries the prompt, prior outcomes, feedback, and instructions", () => {
    const brief = buildBrief({
      prompt: "Fix the bug",
      definition: coding,
      stageId: "build",
      history: [{ stageId: "plan", title: "Plan", outcome: "BRANCH: fix/x\nthe plan", transitionTo: "gate" }],
      feedback: "also add a test",
    });
    expect(brief.indexOf("# Task")).toBeLessThan(brief.indexOf("# Earlier stages"));
    expect(brief).toContain("## 1. Plan (plan) → gate");
    expect(brief).toContain("BRANCH: fix/x");
    expect(brief).toContain("# Feedback from Chad\n\nalso add a test");
    expect(brief).toContain("# Your stage: Build\n\nbuild");
    expect(brief).not.toContain("# Finishing");
  });

  it("tells sandboxed stages (harness and agent, 0013) where the checkout is", () => {
    const withAgent: MachineDefinition = {
      ...coding,
      stages: { ...coding.stages, review: { kind: "agent", title: "Review", instructions: "r", next: [] } },
    };
    const at = (stageId: string) =>
      buildBrief({ prompt: "x", definition: withAgent, stageId, history: [], workspaceRoot: "/work/c_1" });
    expect(at("plan")).toContain("`/work/c_1/<repo>`");
    expect(at("review")).toContain("`/work/c_1/<repo>`");
    expect(at("gate")).not.toContain("# Workspace");
  });
});
