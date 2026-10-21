import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getConversation, setConversationSkill } from "../db/chat";
import { applyApprovedPromptChangeStep } from "../workflows/chat/steps/prompt-change";
import { getTarget } from "../db/prompt-settings";
import { projects } from "../db/schema";
import { advancePhase, applyEnterMode, enterModePreview } from "../lib/agent/tools/modes";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0055 v7: enter_mode's preview/apply and advance_phase (the tool
 * cores, same pattern as tests/plan.test.ts), plus tool registration
 * and stickiness, flag gating (a skill is a mode iff its `mode` flag
 * is set — never inferred from an id), and zero-phase/legacy-adopt
 * behavior. The owner-entry send path lives in tests/mode-entry.test.ts;
 * full agent-turn behavior (tools wired through hooks) lives in
 * tests/x-chat.test.ts with the scripted mock.
 */

let seq = 0;
function conv(): string {
  const id = `c_test_modetools_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

const PROJECT_ID = "p_test_modetools";
function ensureProject() {
  db()
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Mode Tools Test", createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

function convInProject(): string {
  ensureProject();
  const id = `c_test_modetools_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id, PROJECT_ID);
  return id;
}

/** A skill with phase headings but no mode flag — proves mode-ness is
 *  flag-driven, not inferred from heading shape. */
async function createNonModeSkillWithPhaseHeadings(id: string) {
  const target = getTarget(db(), { kind: "skill", id });
  await applyApprovedPromptChangeStep(
    { kind: "skill", id },
    {
      body: "Brief.\n\n## Phase: Plan\n\nPlan body.\n\n## Phase: Ship\n\nShip body.",
      description: "Looks like a mode but isn't flagged as one",
      thread: true,
      mode: false,
    },
    target?.version ?? 0,
    "test: non-mode skill with phase headings",
  );
}

async function createMode(id: string, body: string) {
  const target = getTarget(db(), { kind: "skill", id });
  await applyApprovedPromptChangeStep(
    { kind: "skill", id },
    { body, description: `Test mode ${id}`, thread: true, mode: true, status: "active" },
    target?.version ?? 0,
    "test: create mode skill",
  );
}

describe("enterModePreview", () => {
  it("refuses without a project", () => {
    const id = conv();
    expect(enterModePreview(id, { mode: "ticket", ticket: "ENG-1", reason: "needs a plan" })).toMatchObject({
      ok: false,
      code: "no-project",
    });
  });

  it("refuses an unknown mode", () => {
    const id = convInProject();
    expect(enterModePreview(id, { mode: "sprint", ticket: "x", reason: "y" })).toMatchObject({
      ok: false,
      code: "unknown-mode",
    });
  });

  it("refuses a skill that isn't flagged as a mode, even with phase headings in its body", async () => {
    const id = convInProject();
    await createNonModeSkillWithPhaseHeadings("fake-mode");
    expect(enterModePreview(id, { mode: "fake-mode", ticket: "x", reason: "y" })).toMatchObject({
      ok: false,
      code: "unknown-mode",
    });
  });

  it("refuses when already moded", () => {
    const id = convInProject();
    setConversationSkill(db(), id, "ticket");
    expect(enterModePreview(id, { mode: "ticket", ticket: "x", reason: "y" })).toMatchObject({
      ok: false,
      code: "already-moded",
    });
  });

  it("refuses when a different skill is bound", () => {
    const id = convInProject();
    setConversationSkill(db(), id, "review");
    expect(enterModePreview(id, { mode: "ticket", ticket: "x", reason: "y" })).toMatchObject({
      ok: false,
      code: "already-moded",
    });
  });

  it("refuses a disabled mode", async () => {
    const id = convInProject();
    await createMode("disabled-mode", "## Phase: Plan\n\nPlan body.");
    const target = getTarget(db(), { kind: "skill", id: "disabled-mode" });
    await applyApprovedPromptChangeStep(
      { kind: "skill", id: "disabled-mode" },
      { status: "disabled" },
      target?.version ?? 0,
      "test: disable mode",
    );
    expect(enterModePreview(id, { mode: "disabled-mode", ticket: "x", reason: "y" })).toMatchObject({
      ok: false,
      code: "mode-disabled",
    });
  });

  it("previews ok, carrying the drafted ticket and reason in the summary", () => {
    const id = convInProject();
    const preview = enterModePreview(id, { mode: "ticket", ticket: "ENG-42 fix the widget", reason: "needs a plan and a PR" });
    expect(preview).toMatchObject({ ok: true });
    if (preview.ok) {
      expect(preview.summary).toContain("ENG-42 fix the widget");
      expect(preview.summary).toContain("needs a plan and a PR");
    }
    // Preview never writes anything.
    expect(getConversation(db(), id)?.skill).toBeNull();
  });
});

describe("applyEnterMode", () => {
  it("writes skill + first declared phase, and returns the rendered entry content", async () => {
    const id = convInProject();
    const result = await applyEnterMode(id, "ticket", "ENG-42 fix the widget");
    expect(result).toMatchObject({ ok: true, mode: "ticket", phase: "plan", ticket: "ENG-42 fix the widget" });
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
    if (result.ok) {
      expect(result.runbook).toContain("## Plan");
      expect(result.runbook).toContain("present_plan");
      expect(result.runbook).toContain("Phases:");
      expect(result.runbook).toContain("## Shared");
      expect(result.runbook).not.toContain("{{owner");
    }
  });

  it("a phaseless mode writes phase \"\" and still renders a usable entry", async () => {
    const id = convInProject();
    await createMode("phaseless-mode", "Just a brief, nothing more.");
    const result = await applyEnterMode(id, "phaseless-mode", "whatever");
    expect(result).toMatchObject({ ok: true, mode: "phaseless-mode", phase: "" });
    expect(getConversation(db(), id)?.modePhase).toBe("");
  });
});

describe("advancePhase", () => {
  it("refuses outside any mode", async () => {
    const id = convInProject();
    expect(await advancePhase(id, "implement")).toMatchObject({ ok: false, code: "not-moded" });
  });

  it("refuses on a non-mode skill bound to the thread", async () => {
    const id = convInProject();
    setConversationSkill(db(), id, "review");
    expect(await advancePhase(id, "anything")).toMatchObject({ ok: false, code: "not-moded" });
  });

  it("a zero-phase mode refuses advance_phase outright", async () => {
    const id = convInProject();
    await createMode("empty-mode", "Just a brief, no phase headings at all.");
    await applyEnterMode(id, "empty-mode", "x");
    expect(await advancePhase(id, "anything")).toMatchObject({ ok: false, code: "no-phases" });
  });

  it("advances to the next declared phase, returning that phase's own section", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    const result = await advancePhase(id, "implement");
    expect(result).toMatchObject({ ok: true, from: "plan", to: "implement" });
    expect(getConversation(db(), id)?.modePhase).toBe("implement");
    if (result.ok) {
      expect(result.instructions).toContain("## Implement");
      expect(result.instructions).not.toContain("## Shared");
    }
  });

  it("refuses a same-phase move, and an unknown phase lists the declared names", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    expect(await advancePhase(id, "plan")).toMatchObject({ ok: false, code: "same-phase" });
    const unknown = await advancePhase(id, "sprint");
    expect(unknown).toMatchObject({ ok: false, code: "unknown-phase" });
    if (!unknown.ok) {
      expect(unknown.message).toContain("Plan");
      expect(unknown.message).toContain("Ship");
    }
  });

  it("a forward skip needs a note; the very next phase does not", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    expect(await advancePhase(id, "review")).toMatchObject({ ok: false, code: "needs-note" });
    expect(await advancePhase(id, "review", "skipping implement, trivial change")).toMatchObject({
      ok: true,
      from: "plan",
      to: "review",
    });
  });

  it("moving backward needs a note", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    await advancePhase(id, "implement");
    expect(await advancePhase(id, "plan")).toMatchObject({ ok: false, code: "needs-note" });
    expect(await advancePhase(id, "plan", "found a design flaw")).toMatchObject({ ok: true, from: "implement", to: "plan" });
  });

  it("matches phase names case-insensitively", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    expect(await advancePhase(id, "IMPLEMENT")).toMatchObject({ ok: true, from: "plan", to: "implement" });
  });
});

describe("advancePhase: adopting a legacy mode-skill thread (skill bound before mode_phase existed)", () => {
  it("adopts with a note, from: null, returning that phase's instructions", async () => {
    const id = convInProject();
    setConversationSkill(db(), id, "ticket"); // bound directly — no mode_phase, the pre-0055 shape
    const result = await advancePhase(id, "plan", "starting the plan now");
    expect(result).toMatchObject({ ok: true, from: null, to: "plan" });
    expect(getConversation(db(), id)?.modePhase).toBe("plan");
    if (result.ok) expect(result.instructions).toContain("## Plan");
  });

  it("refuses without a note — there is no prior phase to reason from", async () => {
    const id = convInProject();
    setConversationSkill(db(), id, "ticket");
    expect(await advancePhase(id, "implement")).toMatchObject({ ok: false, code: "needs-note" });
    expect(getConversation(db(), id)?.modePhase).toBeNull();
  });

  it("adopts straight into any declared phase once a note is given", async () => {
    const id = convInProject();
    setConversationSkill(db(), id, "ticket");
    const result = await advancePhase(id, "implement", "already coded it before this upgrade");
    expect(result).toMatchObject({ ok: true, from: null, to: "implement" });
    expect(getConversation(db(), id)?.modePhase).toBe("implement");
  });
});

describe("stickiness: the mode is never cleared once entered", () => {
  it("skill stays \"ticket\" through every phase move, forward and backward", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket", "ENG-1");
    await advancePhase(id, "implement");
    expect(getConversation(db(), id)?.skill).toBe("ticket");
    await advancePhase(id, "review");
    expect(getConversation(db(), id)?.skill).toBe("ticket");
    await advancePhase(id, "plan", "going back to replan");
    expect(getConversation(db(), id)?.skill).toBe("ticket");
  });
});

describe("tool registration (0055)", () => {
  it("enter_mode and advance_phase are always-on (core) tools; use_skill takes no id", () => {
    const names = Object.keys(buildChatTools("c_x", { hasSandbox: false, hasProject: false }));
    expect(names).toContain("enter_mode");
    expect(names).toContain("advance_phase");
    expect(names).toContain("use_skill");
  });
});
