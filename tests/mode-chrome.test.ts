import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, setConversationMode, setConversationSkill } from "../db/chat";
import { getTarget } from "../db/prompt-settings";
import { projects } from "../db/schema";
import { applyApprovedPromptChangeStep } from "../workflows/chat/steps/prompt-change";
import { loadModeChrome } from "../lib/chat/mode-chrome";

/** 0055 PR2: the Mode chip's read model. */

let seq = 0;
const PROJECT_ID = "p_test_modechrome";
function ensureProject() {
  db().insert(projects).values({ id: PROJECT_ID, name: "Mode Chrome Test", createdAt: 0 }).onConflictDoNothing().run();
}
function conv(): string {
  ensureProject();
  const id = `c_test_modechrome_${++seq}`;
  ensureConversation(db(), id, PROJECT_ID);
  return id;
}

async function createMode(id: string, body: string) {
  const target = getTarget(db(), { kind: "skill", id });
  await applyApprovedPromptChangeStep(
    { kind: "skill", id },
    { body, description: "test mode", thread: true, mode: true, status: "active" },
    target?.version ?? 0,
    "test: create mode",
  );
}

describe("loadModeChrome", () => {
  it("null for a plain chat (no skill bound)", async () => {
    expect(await loadModeChrome(conv())).toBeNull();
  });

  it("null for a chat bound to a non-mode skill", async () => {
    const id = conv();
    setConversationSkill(db(), id, "review");
    expect(await loadModeChrome(id)).toBeNull();
  });

  it("reports the title, phase list, and current phase for a moded chat", async () => {
    await createMode("chrome-mode-1", "# Chrome Mode\n\nBrief.\n\n## Phase: Plan\n\nPlan body.\n\n## Phase: Ship\n\nShip body.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-1", "plan");
    expect(await loadModeChrome(id)).toEqual({
      skillId: "chrome-mode-1",
      title: "Chrome Mode",
      phases: [{ id: "plan", name: "Plan" }, { id: "ship", name: "Ship" }],
      current: { id: "plan", name: "Plan" },
    });
  });

  it("current is null for a phaseless mode", async () => {
    await createMode("chrome-mode-2", "# Phaseless\n\nJust a brief.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-2", "");
    const chrome = await loadModeChrome(id);
    expect(chrome?.phases).toEqual([]);
    expect(chrome?.current).toBeNull();
  });

  it("current is null for a legacy thread (skill bound, no phase recorded yet)", async () => {
    await createMode("chrome-mode-3", "## Phase: Plan\n\nPlan body.");
    const id = conv();
    setConversationSkill(db(), id, "chrome-mode-3");
    const chrome = await loadModeChrome(id);
    expect(chrome?.current).toBeNull();
    expect(chrome?.phases).toEqual([{ id: "plan", name: "Plan" }]);
  });

  it("current is null for a stale phase a renamed heading dropped", async () => {
    await createMode("chrome-mode-4", "## Phase: Plan\n\nPlan body.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-4", "gone");
    expect((await loadModeChrome(id))?.current).toBeNull();
  });

  it("falls back to the skill id when the body has no H1", async () => {
    await createMode("chrome-mode-5", "No heading here.\n\n## Phase: Plan\n\nBody.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-5", "plan");
    expect((await loadModeChrome(id))?.title).toBe("chrome-mode-5");
  });
});
