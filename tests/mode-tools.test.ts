import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getConversation, setConversationSkill } from "../db/chat";
import { approvePlanRow, openPlanReview } from "../db/plans";
import { projects } from "../db/schema";
import { advancePhase, applyEnterMode, enterModePreview } from "../lib/agent/tools/modes";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0055 ticket mode: enter_mode's preview/apply and advance_phase (the
 * tool cores, same pattern as tests/plan.test.ts), plus tool
 * registration and stickiness. The owner-entry send path lives in
 * tests/mode-entry.test.ts; full agent-turn behavior (tools wired
 * through hooks) lives in tests/x-chat.test.ts with the scripted mock.
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

function approvedPlan(conversationId: string) {
  const rowId = `p_${conversationId}`;
  openPlanReview(db(), {
    id: rowId,
    conversationId,
    card: { kind: "plan", version: 1, markdown: "# Plan", checklist: { done: 1, total: 1 } },
  });
  approvePlanRow(db(), rowId);
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
  it("writes skill=ticket and phase=plan, and returns the rendered intro + plan section", async () => {
    const id = convInProject();
    const result = await applyEnterMode(id, "ENG-42 fix the widget");
    expect(result).toMatchObject({ ok: true, mode: "ticket", phase: "plan", ticket: "ENG-42 fix the widget" });
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
    if (result.ok) {
      expect(result.runbook).toContain("## plan");
      expect(result.runbook).toContain("present_plan");
      expect(result.runbook).not.toContain("{{owner");
    }
  });
});

describe("advancePhase", () => {
  it("refuses outside ticket mode", async () => {
    const id = convInProject();
    expect(await advancePhase(id, "implement")).toMatchObject({ ok: false, code: "not-moded" });
  });

  it("refuses implement without an approved plan, naming the rule", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    const result = await advancePhase(id, "implement");
    expect(result).toMatchObject({ ok: false, code: "unapproved-plan" });
    if (!result.ok) expect(result.message).toContain("present_plan");
  });

  it("advances to implement once the plan is approved, returning that phase's instructions", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    approvedPlan(id);
    const result = await advancePhase(id, "implement");
    expect(result).toMatchObject({ ok: true, from: "plan", to: "implement" });
    expect(getConversation(db(), id)?.modePhase).toBe("implement");
    if (result.ok) {
      expect(result.instructions).toContain("## implement");
      expect(result.instructions).toContain("claude");
    }
  });

  it("refuses a same-phase move and a forward skip, naming the rule", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    expect(await advancePhase(id, "plan")).toMatchObject({ ok: false, code: "same-phase" });
    expect(await advancePhase(id, "review")).toMatchObject({ ok: false, code: "skip" });
  });

  it("the review <-> fixup loop works without a note", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    approvedPlan(id);
    await advancePhase(id, "implement");
    await advancePhase(id, "review");
    expect(await advancePhase(id, "fixup")).toMatchObject({ ok: true, from: "review", to: "fixup" });
    expect(await advancePhase(id, "review")).toMatchObject({ ok: true, from: "fixup", to: "review" });
  });

  it("moving further back needs a note", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    approvedPlan(id);
    await advancePhase(id, "implement");
    expect(await advancePhase(id, "plan")).toMatchObject({ ok: false, code: "needs-note" });
    expect(await advancePhase(id, "plan", "found a design flaw")).toMatchObject({ ok: true, from: "implement", to: "plan" });
  });
});

describe("stickiness: the mode is never cleared once entered", () => {
  it("skill stays \"ticket\" through every phase move, forward and backward", async () => {
    const id = convInProject();
    await applyEnterMode(id, "ticket");
    approvedPlan(id);
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
