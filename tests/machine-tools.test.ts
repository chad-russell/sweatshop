import { describe, expect, it } from "vitest";
import { db } from "../db";
import { createMachine, getMachine, type Machine } from "../db/machines";
import type { MachineDefinition } from "../lib/machines/definition";
import {
  createMachineTool,
  deleteMachineTool,
  editMachineTool,
  getMachineTool,
  listMachinesCatalog,
  machineDeletePreview,
  previewCreateMachine,
} from "../lib/agent/tools/machines";

/**
 * 0015 Part A — the machine tool cores against the per-worker temp db.
 * The workflow steps that wrap them are thin (same pattern as 0010's
 * bash/attach cores); the mock-LLM edit_machine round trip lives in
 * x-chat.test.ts.
 */

const ticket: MachineDefinition = {
  workspace: "project",
  start: "plan",
  stages: {
    plan: { kind: "harness", harness: "pi", title: "Plan", instructions: "plan", next: [{ to: "verify" }] },
    verify: { kind: "harness", harness: "pi", title: "Verify", instructions: "verify", next: [], maxVisits: 3 },
  },
};

function make(id: string): Machine {
  return createMachine(db(), { id, name: id, definition: ticket });
}

describe("0015 machine tool cores", () => {
  it("lists machines with workspace, version and stage count", () => {
    make("m-list");
    const catalog = listMachinesCatalog();
    const entry = catalog.machines.find((m) => m.id === "m-list")!;
    expect(entry).toMatchObject({ name: "m-list", workspace: "project", version: 1, stages: 2 });
    expect(entry.description).toBeNull();
  });

  it("reads a machine's full definition and version", () => {
    make("m-read");
    const result = getMachineTool("m-read");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.machine.version).toBe(1);
    expect(result.machine.definition).toEqual(ticket);
    expect(getMachineTool("m-ghost")).toMatchObject({ ok: false, code: "not-found" });
  });

  it("creates with a generated id, and reports invalid definitions without creating", () => {
    const created = createMachineTool({ name: "Generated", definition: ticket });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.machine.id).toMatch(/^m-[a-z0-9]{8}$/);
    expect(created.machine.stages).toBe(2);

    const bad = createMachineTool({
      name: "Bad",
      definition: { workspace: "none", start: "ghost", stages: { a: { kind: "agent", title: "A", instructions: "", next: [] } } },
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid" });
    if (bad.ok) return;
    expect(bad.issues!.general.join("\n")).toContain('start stage "ghost" does not exist');
    expect(listMachinesCatalog().machines.some((m) => m.name === "Bad")).toBe(false);
  });

  it("previews a create for Chad's approval without writing, and refuses taken ids", () => {
    const preview = previewCreateMachine({ id: "m-preview", name: "Preview", definition: ticket });
    expect(preview).toMatchObject({ ok: true });
    if (!preview.ok) return;
    expect(preview.summary).toContain('Create machine "Preview" (m-preview) — 2 stages: pi → pi; workspace project');
    expect(getMachineTool("m-preview")).toMatchObject({ ok: false, code: "not-found" });

    expect(previewCreateMachine({ name: "Bad", definition: { workspace: "none" } })).toMatchObject({ ok: false, code: "invalid" });
    make("m-taken");
    expect(previewCreateMachine({ id: "m-taken", name: "Taken", definition: ticket })).toMatchObject({ ok: false, code: "conflict" });
  });

  it("edits with a version bump; name/description ride along", () => {
    make("m-edit");
    const result = editMachineTool({
      id: "m-edit",
      baseVersion: 1,
      ops: [
        { op: "add_stage", kind: "human", title: "Approve" },
        { op: "disconnect", source: "plan", target: "verify" },
        { op: "connect", source: "plan", target: "approve" },
        { op: "connect", source: "approve", target: "verify", when: "ok" },
      ],
      name: "Edited",
    });
    expect(result).toMatchObject({ ok: true, machine: { version: 2, name: "Edited", stages: 3 } });
    const stored = getMachine(db(), "m-edit");
    expect(stored.definition.stages.approve).toBeDefined();
    expect(stored.definition.stages.plan!.next).toEqual([{ to: "approve" }]);
  });

  it("an invalid batch saves nothing and returns issues by element with the draft shape", () => {
    make("m-invalid");
    // harness stages need workspace: project — switching to none leaves
    // every harness stage invalid without any op failing to apply.
    const result = editMachineTool({
      id: "m-invalid",
      baseVersion: 1,
      ops: [{ op: "set_workspace", workspace: "none" }],
    });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    if (result.ok) return;
    expect(result.issues!.stages.plan![0]).toContain("harness stages need workspace: project");
    expect(result.issues!.stages.verify).toBeDefined();
    expect(result.draft!.stages.map((s) => s.id)).toEqual(["plan", "verify"]);
    // nothing was saved
    const stored = getMachine(db(), "m-invalid");
    expect(stored.version).toBe(1);
    expect(stored.definition.workspace).toBe("project");
    expect(stored.name).toBe("m-invalid");
  });

  it("an op that cannot apply is reported with its index, saving nothing", () => {
    make("m-badop");
    const result = editMachineTool({
      id: "m-badop",
      baseVersion: 1,
      ops: [{ op: "connect", source: "plan", target: "ghost" }],
    });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    if (result.ok) return;
    expect(result.message).toContain('op 0 (connect): stage "ghost" does not exist');
    expect(getMachine(db(), "m-badop").version).toBe(1);
  });

  it("a stale baseVersion is a conflict carrying the current version", () => {
    make("m-conflict");
    const first = editMachineTool({
      id: "m-conflict",
      baseVersion: 1,
      ops: [{ op: "update_stage", stage: "plan", patch: { title: "Planning" } }],
    });
    expect(first).toMatchObject({ ok: true });
    const stale = editMachineTool({
      id: "m-conflict",
      baseVersion: 1,
      ops: [{ op: "update_stage", stage: "plan", patch: { title: "Clobber" } }],
    });
    expect(stale).toMatchObject({ ok: false, code: "conflict", currentVersion: 2 });
    expect(getMachine(db(), "m-conflict").definition.stages.plan!.title).toBe("Planning");
    expect(editMachineTool({ id: "m-ghost", baseVersion: 1, ops: [{ op: "set_start", stage: "plan" }] })).toMatchObject({
      ok: false,
      code: "not-found",
    });
  });

  it("delete previews, deletes, and reports missing machines", () => {
    make("m-delete");
    expect(machineDeletePreview("m-delete")).toMatchObject({ ok: true, machine: { stages: 2, version: 1 } });
    expect(machineDeletePreview("m-ghost")).toMatchObject({ ok: false, code: "not-found" });
    const gone = deleteMachineTool("m-delete");
    expect(gone).toMatchObject({ ok: true, deleted: { id: "m-delete" } });
    expect(machineDeletePreview("m-delete")).toMatchObject({ ok: false, code: "not-found" });
    expect(deleteMachineTool("m-delete")).toMatchObject({ ok: false, code: "not-found" });
  });
});
