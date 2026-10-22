import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getConversation } from "../db/chat";
import { projects } from "../db/schema";
import { buildChatTools } from "../workflows/chat/tools";
import { skillToolStep } from "../workflows/chat/steps/turn";

/**
 * 0059: use_skill loads a skill (a mode comes back with suggested steps
 * and writes conversations.skill). enter_mode and advance_phase are gone.
 */

let seq = 0;
const PROJECT_ID = "p_test_modetools";

function convInProject(): string {
  db().insert(projects).values({ id: PROJECT_ID, name: "Mode Tools Test", createdAt: Date.now() }).onConflictDoNothing().run();
  const id = `c_test_modetools_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id, PROJECT_ID);
  return id;
}

describe("use_skill loads a mode", () => {
  it("returns the body and suggested steps, and records the mode", async () => {
    const id = convInProject();
    const result = await skillToolStep(id, "ticket");
    expect(result).toMatchObject({
      ok: true,
      id: "ticket",
      mode: true,
      suggestedSteps: [
        { label: "Plan", state: "active" },
        { label: "Implement", state: "pending" },
        { label: "Review", state: "pending" },
        { label: "Fixup", state: "pending" },
        { label: "Ship", state: "pending" },
      ],
    });
    expect((result as { skill: string }).skill).toContain("update_status");
    expect((result as { skill: string }).skill).not.toContain("{{owner");
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
  });

  it("a later mode load overwrites the recorded skill", async () => {
    const id = convInProject();
    await skillToolStep(id, "ticket");
    const again = await skillToolStep(id, "ticket");
    expect(again).toMatchObject({ ok: true, mode: true });
    expect(getConversation(db(), id)?.skill).toBe("ticket");
  });

  it("listing omits the id and does not bind", async () => {
    const id = convInProject();
    const listed = await skillToolStep(id);
    expect(listed).toMatchObject({ ok: true });
    expect(getConversation(db(), id)?.skill).toBeNull();
    const skills = (listed as { skills: { id: string; mode: boolean; thread: boolean }[] }).skills;
    expect(skills.some((s) => s.id === "ticket" && s.mode && s.thread)).toBe(true);
    expect(skills.some((s) => s.id === "review" && s.thread && !s.mode)).toBe(true);
    expect(skills.some((s) => s.id === "ship")).toBe(false);
  });

  it("a mode load in a chat with no project returns the body and does not bind", async () => {
    const id = `c_test_modetools_noproj_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
    ensureConversation(db(), id, null);
    const result = await skillToolStep(id, "ticket");
    expect(result).toMatchObject({
      ok: true,
      id: "ticket",
      mode: true,
      bound: false,
      reason: "modes need a project",
    });
    expect((result as { skill: string }).skill).toContain("update_status");
    expect(getConversation(db(), id)).toMatchObject({ skill: null, modePhase: null });
  });
});

describe("tool registration (0064)", () => {
  it("update_outline, accept_outline and use_skill are always-on; enter_mode, advance_phase and update_status are gone", () => {
    const names = Object.keys(buildChatTools("c_x", { hasSandbox: false, hasProject: false }));
    expect(names).toContain("update_outline");
    expect(names).toContain("accept_outline");
    expect(names).toContain("use_skill");
    expect(names).not.toContain("enter_mode");
    expect(names).not.toContain("advance_phase");
    expect(names).not.toContain("update_status");
  });
});
