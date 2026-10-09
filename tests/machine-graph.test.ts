import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseDefinition, type MachineDefinition } from "../lib/machines/definition";
import {
  addStage,
  applyOps,
  connect,
  disconnect,
  editOpSchema,
  EditError,
  freeStageId,
  issuesByElement,
  removeStage,
  renameStage,
  setKind,
  setStart,
  updateStage,
  updateTransition,
} from "../lib/machines/edit";
import { layoutMachine, NODE_HEIGHT, NODE_WIDTH, pickDirection } from "../lib/machines/layout";

/** 0014: the pure graph core — layout and edit operations. */

const seed = (name: string): MachineDefinition =>
  (JSON.parse(readFileSync(path.join(process.cwd(), "lib/machines/seeds", `${name}.json`), "utf8")) as {
    definition: MachineDefinition;
  }).definition;

const SEEDS = ["think", "ticket"] as const;

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

describe("layoutMachine", () => {
  it.each(SEEDS)("lays out the %s seed with no overlapping nodes, start leftmost, end rightmost", (name) => {
    const def = seed(name);
    const { nodes } = layoutMachine(def);
    expect(nodes.map((n) => n.id).sort()).toEqual([...Object.keys(def.stages), "end"].sort());
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) expect(overlaps(nodes[i]!, nodes[j]!)).toBe(false);
    }
    const start = nodes.find((n) => n.id === def.start)!;
    const end = nodes.find((n) => n.id === "end")!;
    expect(start.rank).toBe(0);
    expect(Math.max(...nodes.map((n) => n.rank))).toBe(end.rank);
  });

  it("marks loops as back edges and keeps forward edges left-to-right", () => {
    const { nodes, edges } = layoutMachine(seed("ticket"));
    const rank = new Map(nodes.map((n) => [n.id, n.rank]));
    const back = edges.filter((e) => e.back).map((e) => e.id);
    // 0023: loops — verify→implement, the approve→plan revise edge, and
    // 0034 A's pr-approve→implement request-changes edge
    expect(back).toEqual(["approve->plan", "verify->implement", "pr-approve->implement"]);
    for (const e of edges.filter((x) => !x.back)) expect(rank.get(e.target)!).toBeGreaterThan(rank.get(e.source)!);
  });

  it("adds an implicit dashed edge to end for stages with no next", () => {
    const { edges } = layoutMachine(seed("ticket"));
    expect(edges.find((e) => e.source === "publish")).toMatchObject({ target: "end", implicit: true, index: null });
    expect(edges.find((e) => e.id === "approve->end")).toMatchObject({ implicit: false, when: "Reject" });
  });

  it("is deterministic and tolerates an invalid draft (dangling target, unreachable stage)", () => {
    const draft: MachineDefinition = {
      workspace: "none",
      start: "a",
      stages: {
        a: { kind: "agent", title: "A", instructions: "", next: [{ to: "ghost" }, { to: "b" }] },
        b: { kind: "human", title: "B", instructions: "", next: [{ to: "end" }] },
        orphan: { kind: "agent", title: "O", instructions: "", next: [{ to: "b" }] },
      },
    };
    const one = layoutMachine(draft);
    expect(one).toEqual(layoutMachine(draft));
    expect(one.edges.some((e) => e.target === "ghost")).toBe(false);
    expect(one.nodes.find((n) => n.id === "orphan")).toBeDefined();
  });
});

describe("top-to-bottom layout", () => {
  it.each(SEEDS)("lays out %s with no overlaps and ranks running down", (name) => {
    const def = seed(name);
    const { nodes, edges, direction, width, height } = layoutMachine(def, "TB");
    expect(direction).toBe("TB");
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) expect(overlaps(nodes[i]!, nodes[j]!)).toBe(false);
    }
    const y = new Map(nodes.map((n) => [n.id, n.y]));
    for (const e of edges.filter((x) => !x.back)) expect(y.get(e.target)!).toBeGreaterThan(y.get(e.source)!);
    expect(Math.min(...nodes.map((n) => n.x))).toBeGreaterThanOrEqual(0);
    expect(width).toBeGreaterThanOrEqual(NODE_WIDTH);
    expect(height).toBeGreaterThan(0);
    // same graph, same ranks, whichever way it flows
    const lr = layoutMachine(def, "LR");
    expect(nodes.map((n) => [n.id, n.rank])).toEqual(lr.nodes.map((n) => [n.id, n.rank]));
  });

  it("picks vertical for a narrow container, horizontal for a wide one", () => {
    const def = seed("think");
    expect(pickDirection(def, { width: 360, height: 700 })).toBe("TB");
    expect(pickDirection(def, { width: 1200, height: 600 })).toBe("LR");
    expect(pickDirection(def, { width: 0, height: 0 })).toBe("LR");
  });
});

describe("edit operations", () => {
  const think = seed("think");

  it("adds a stage with a free id from its title and leaves the draft valid", () => {
    const { definition, id } = addStage(think, { kind: "agent", title: "Draft" });
    expect(id).toBe("draft-2");
    expect(definition.stages[id]).toMatchObject({ kind: "agent", title: "Draft", next: [] });
    expect(parseDefinition(definition).ok).toBe(true);
    expect(freeStageId(think, "Plan It!")).toBe("plan-it");
    expect(() => addStage(think, { id: "end", kind: "human" })).toThrow(EditError);
  });

  it("renames a stage and rewrites start and every reference to it", () => {
    const renamed = renameStage(think, "draft", "write");
    expect(renamed.start).toBe("write");
    expect(renamed.stages.draft).toBeUndefined();
    const critique = renameStage(think, "critique", "review");
    expect(critique.stages.draft!.next).toEqual([{ to: "review" }]);
    expect(critique.stages.decide!.next.map((t) => t.to)).toEqual(["end", "review"]);
    expect(parseDefinition(critique).ok).toBe(true);
    expect(() => renameStage(think, "draft", "decide")).toThrow(EditError);
    expect(() => renameStage(think, "draft", "Bad Id")).toThrow(EditError);
  });

  it("removes a stage and every transition into it", () => {
    const removed = removeStage(think, "critique");
    expect(Object.keys(removed.stages)).toEqual(["draft", "decide"]);
    expect(removed.stages.draft!.next).toEqual([]);
    expect(removed.stages.decide!.next.map((t) => t.to)).toEqual(["end"]);
  });

  it("connects, labels, and disconnects transitions", () => {
    const linked = connect(think, "draft", "end", "  Good enough ");
    expect(linked.stages.draft!.next).toEqual([{ to: "critique" }, { to: "end", when: "Good enough" }]);
    expect(connect(linked, "draft", "end")).toBe(linked);
    const relabeled = updateTransition(linked, "draft", "end", "");
    expect(relabeled.stages.draft!.next[1]).toEqual({ to: "end" });
    expect(disconnect(linked, "draft", "end").stages.draft!.next).toEqual([{ to: "critique" }]);
    expect(() => connect(think, "draft", "ghost")).toThrow(EditError);
    expect(() => disconnect(think, "draft", "end")).toThrow(EditError);
  });

  it("updates fields per kind and changes kinds while keeping the shared fields", () => {
    const edited = updateStage(think, "draft", { title: "Write", maxVisits: 5 });
    expect(edited.stages.draft).toMatchObject({ title: "Write", maxVisits: 5 });
    expect(updateStage(edited, "draft", { maxVisits: undefined }).stages.draft).not.toHaveProperty("maxVisits");
    expect(() => updateStage(think, "draft", { harness: "claude" })).toThrow(EditError);
    const human = setKind(edited, "draft", "human");
    expect(human.stages.draft).toEqual({ kind: "human", title: "Write", instructions: think.stages.draft!.instructions, next: [{ to: "critique" }], maxVisits: 5 });
    const harness = setKind(think, "draft", "harness");
    expect(harness.stages.draft).toMatchObject({ kind: "harness", harness: "pi" });
    // harness stages need a project workspace — an invalid draft, by design.
    expect(parseDefinition(harness).ok).toBe(false);
    expect(setStart(think, "decide").start).toBe("decide");
  });

  it("applyOps: applies a batch in order, through invalid intermediates, to a valid result (0015)", () => {
    // The 0015 live-check scenario: on the ticket machine, remove the
    // start stage (dangling start — invalid mid-batch), re-point start,
    // then add a lint stage after implement that loops back on failure.
    const batched = applyOps(seed("ticket"), [
      { op: "remove_stage", stage: "plan" },
      { op: "set_start", stage: "approve" },
      { op: "add_stage", kind: "harness", title: "Lint" },
      { op: "connect", source: "implement", target: "lint" },
      { op: "disconnect", source: "implement", target: "verify" },
      { op: "connect", source: "lint", target: "verify", when: "Clean" },
      { op: "connect", source: "lint", target: "implement", when: "Lint failed (explain)" },
      { op: "update_stage", stage: "lint", patch: { maxVisits: 2 } },
    ]);
    expect(parseDefinition(batched).ok).toBe(true);
    expect(batched.start).toBe("approve");
    expect(batched.stages.approve!.next.map((t) => t.to)).toEqual(["implement", "end"]);
    expect(batched.stages.implement!.next).toEqual([{ to: "lint" }]);
    expect(batched.stages.lint).toMatchObject({ kind: "harness", harness: "pi", title: "Lint", maxVisits: 2 });
    expect(batched.stages.lint!.next).toEqual([
      { to: "verify", when: "Clean" },
      { to: "implement", when: "Lint failed (explain)" },
    ]);
    // every op moved the definition; none touched the input
    expect(batched).not.toBe(seed("ticket"));
    expect(seed("ticket").stages.plan).toBeDefined();
  });

  it("applyOps: an op that cannot apply throws EditError naming its index", () => {
    try {
      applyOps(think, [
        { op: "connect", source: "draft", target: "critique" }, // no-op: exists
        { op: "connect", source: "draft", target: "ghost" },
      ]);
      expect.unreachable("second op must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EditError);
      expect((error as Error).message).toBe('op 1 (connect): stage "ghost" does not exist');
    }
  });

  it("applyOps: null in a patch clears the field (JSON has no undefined)", () => {
    const cleared = applyOps(seed("ticket"), [{ op: "update_stage", stage: "verify", patch: { maxVisits: null } }]);
    expect(cleared.stages.verify).not.toHaveProperty("maxVisits");
    expect(parseDefinition(cleared).ok).toBe(true);
    const set = applyOps(cleared, [{ op: "update_stage", stage: "verify", patch: { maxVisits: 5 } }]);
    expect(set.stages.verify).toMatchObject({ maxVisits: 5 });
  });

  it("editOpSchema parses the JSON shape a tool call arrives as", () => {
    const ops = z.array(editOpSchema);
    const parsed = ops.safeParse([
      { op: "add_stage", kind: "agent", title: "Reflect" },
      { op: "connect", source: "draft", target: "reflect" },
      { op: "update_stage", stage: "reflect", patch: { instructions: "Look back", maxVisits: null } },
    ]);
    expect(parsed.success).toBe(true);
    expect(ops.safeParse([{ op: "nope" }]).success).toBe(false);
  });
});

describe("issuesByElement", () => {
  it("places issues on the stage or edge they name", () => {
    const draft: MachineDefinition = {
      ...seed("think"),
      start: "gone",
      stages: {
        ...seed("think").stages,
        draft: { kind: "harness", harness: "pi", title: "Draft", instructions: "", next: [{ to: "critique" }, { to: "ghost" }] },
        decide: { kind: "human", title: "Decide", instructions: "", next: [{ to: "end" }, { to: "end" }] },
      },
    };
    const parsed = parseDefinition(draft);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const issues = issuesByElement(draft, parsed.errors);
    expect(issues.general.some((e) => e.startsWith("start:"))).toBe(true);
    // harness in a workspace-free machine → the node; dangling target → the node (no drawn edge).
    expect(issues.nodes.get("draft")?.some((m) => m.includes("workspace: project"))).toBe(true);
    expect(issues.nodes.get("draft")?.some((m) => m.includes('"ghost" does not exist'))).toBe(true);
    expect(issues.edges.get("decide->end")?.[0]).toMatch(/duplicate transition/);
  });
});
