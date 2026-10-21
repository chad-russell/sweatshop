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

  it("reports {kind: 'bound'} for a chat bound to a non-mode skill — the server refuses a new mode there too", async () => {
    const id = conv();
    setConversationSkill(db(), id, "review");
    expect(await loadModeChrome(id)).toEqual({ kind: "bound", skillId: "review" });
  });

  it("reports {kind: 'bound'} for a chat bound to a deleted skill", async () => {
    const id = conv();
    setConversationSkill(db(), id, "no-such-skill");
    expect(await loadModeChrome(id)).toEqual({ kind: "bound", skillId: "no-such-skill" });
  });

  it("reports the title, phase list, and current phase for a moded chat", async () => {
    await createMode("chrome-mode-1", "# Chrome Mode\n\nBrief.\n\n## Phase: Plan\n\nPlan body.\n\n## Phase: Ship\n\nShip body.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-1", "plan");
    expect(await loadModeChrome(id)).toEqual({
      kind: "mode",
      skillId: "chrome-mode-1",
      title: "Chrome Mode",
      phases: [{ id: "plan", name: "Plan" }, { id: "ship", name: "Ship" }],
      current: { id: "plan", name: "Plan" },
    });
  });

  it("renders {{owner}} placeholders in the title and phase names, never raw", async () => {
    const prev = process.env.SWEATSHOP_OWNER_NAME;
    process.env.SWEATSHOP_OWNER_NAME = "Riley";
    try {
      await createMode("chrome-mode-owner", "# Demo {{owner}} tour\n\n## Phase: {{owner}} review\n\nBody.");
      const id = conv();
      setConversationMode(db(), id, "chrome-mode-owner", "owner-review");
      const chrome = await loadModeChrome(id);
      expect(chrome).toMatchObject({ kind: "mode", title: "Demo Riley tour", phases: [{ name: "Riley review" }], current: { name: "Riley review" } });
      expect(JSON.stringify(chrome)).not.toContain("{{");
    } finally {
      if (prev === undefined) delete process.env.SWEATSHOP_OWNER_NAME;
      else process.env.SWEATSHOP_OWNER_NAME = prev;
    }
  });

  it("current is null for a phaseless mode", async () => {
    await createMode("chrome-mode-2", "# Phaseless\n\nJust a brief.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-2", "");
    const chrome = await loadModeChrome(id);
    expect(chrome).toMatchObject({ kind: "mode", phases: [], current: null });
  });

  it("current is null for a legacy thread (skill bound, no phase recorded yet)", async () => {
    await createMode("chrome-mode-3", "## Phase: Plan\n\nPlan body.");
    const id = conv();
    setConversationSkill(db(), id, "chrome-mode-3");
    const chrome = await loadModeChrome(id);
    expect(chrome).toMatchObject({ kind: "mode", current: null, phases: [{ id: "plan", name: "Plan" }] });
  });

  it("current is null for a stale phase a renamed heading dropped", async () => {
    await createMode("chrome-mode-4", "## Phase: Plan\n\nPlan body.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-4", "gone");
    expect(await loadModeChrome(id)).toMatchObject({ kind: "mode", current: null });
  });

  it("falls back to the skill id when the body has no H1", async () => {
    await createMode("chrome-mode-5", "No heading here.\n\n## Phase: Plan\n\nBody.");
    const id = conv();
    setConversationMode(db(), id, "chrome-mode-5", "plan");
    expect(await loadModeChrome(id)).toMatchObject({ kind: "mode", title: "chrome-mode-5" });
  });
});
