import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getConversation } from "../db/chat";
import { getTarget } from "../db/prompt-settings";
import { projects } from "../db/schema";
import { applyApprovedPromptChangeStep } from "../workflows/chat/steps/prompt-change";
import { enterModeOnSend } from "../lib/chat/mode-entry";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * 0055 v7 owner entry: `lib/chat/mode-entry.ts` (no approval — the
 * owner's own action) and the send route's `mode` field / legacy
 * `?skill=<id>` equivalence (only when that skill is actually a mode).
 * `tests/mode-tools.test.ts` covers the agent's own approval-gated
 * `enter_mode` tool.
 */

let seq = 0;
const PROJECT_ID = "p_test_modeentry";
function ensureProject() {
  db()
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Mode Entry Test", createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
}

function freshId(): string {
  return `c_test_modeentry_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
}

function conv(): string {
  const id = freshId();
  ensureConversation(db(), id);
  return id;
}

function convInProject(): string {
  ensureProject();
  const id = freshId();
  ensureConversation(db(), id, PROJECT_ID);
  return id;
}

/** A dedicated disabled mode, created fresh each time — never touches
 *  the shared "ticket" fixture other tests in this file rely on. */
async function createDisabledMode(id: string) {
  const target = getTarget(db(), { kind: "skill", id });
  await applyApprovedPromptChangeStep(
    { kind: "skill", id },
    { body: "## Phase: Plan\n\nPlan body.", description: "disabled test mode", thread: true, mode: true, status: "disabled" },
    target?.version ?? 0,
    "test: create disabled mode",
  );
}

describe("enterModeOnSend (owner entry, no approval)", () => {
  it("refuses without a project, writing nothing", async () => {
    const id = conv();
    const result = await enterModeOnSend(db(), id, "ticket", null);
    expect(result).toMatchObject({ ok: false, code: "no-project" });
    expect(getConversation(db(), id)?.skill).toBeNull();
  });

  it("refuses an unknown mode", async () => {
    const id = convInProject();
    const result = await enterModeOnSend(db(), id, "sprint", PROJECT_ID);
    expect(result).toMatchObject({ ok: false, code: "unknown-mode" });
  });

  it("refuses a disabled mode", async () => {
    const id = convInProject();
    await createDisabledMode("disabled-entry-mode");
    const result = await enterModeOnSend(db(), id, "disabled-entry-mode", PROJECT_ID);
    expect(result).toMatchObject({ ok: false, code: "mode-disabled" });
  });

  it("refuses when already moded", async () => {
    const id = convInProject();
    const { setConversationSkill } = await import("../db/chat");
    setConversationSkill(db(), id, "ticket");
    const result = await enterModeOnSend(db(), id, "ticket", PROJECT_ID);
    expect(result).toMatchObject({ ok: false, code: "already-moded" });
  });

  it("writes skill + phase and appends a runEvent 'mode' row carrying the rendered entry content, with no approval step", async () => {
    const id = convInProject();
    const result = await enterModeOnSend(db(), id, "ticket", PROJECT_ID);
    expect(result).toMatchObject({ ok: true });
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });

    const { listMessageTexts } = await import("../db/chat");
    const rows = listMessageTexts(db(), id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user" });
    expect(rows[0]!.metadata).toMatchObject({ runEvent: { kind: "mode", id: "ticket", status: "entered" } });
    expect(rows[0]!.text).toContain("## Plan");
    expect(rows[0]!.text).toContain("Phases:");
    expect(rows[0]!.text).toContain("## Shared");
    expect(rows[0]!.text).not.toContain("{{owner");
  });
});

describe("POST /api/x/chat: mode entry (0055 v7)", () => {
  it("?mode=ticket (body.mode) on a fresh send enters ticket mode, project-scoped", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "ENG-1 fix the widget", projectId: PROJECT_ID, mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
  });

  it("the legacy ?skill=ticket query param means the same thing as mode=ticket, since ticket is a mode", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "ENG-2 fix the other widget", projectId: PROJECT_ID, skill: "ticket" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
  });

  it("?skill=<id> does NOT alias to mode entry when that skill isn't a mode", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "look at this", projectId: PROJECT_ID, skill: "review" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)).toMatchObject({ skill: "review", modePhase: null });
  });

  it("refuses without a project, creating nothing — no orphan conversation row", async () => {
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("refuses an unknown mode name, creating nothing — no orphan conversation row", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", projectId: PROJECT_ID, mode: "sprint" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("refuses a disabled mode by send, creating nothing — no orphan conversation row", async () => {
    ensureProject();
    await createDisabledMode("disabled-entry-mode-2");
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", projectId: PROJECT_ID, mode: "disabled-entry-mode-2" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("refuses a non-mode skill id as mode on a fresh send, creating nothing — no orphan conversation row", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", projectId: PROJECT_ID, mode: "review" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(getConversation(db(), id)).toBeNull();
  });

  it("works on an EXISTING plain chat too, not just a fresh one (unlike skill, which is creation-only)", async () => {
    // ensureConversation (not a send) creates the row directly — an
    // existing, already-created plain chat, same as a chat that has
    // been running a while before the owner decides to enter ticket mode.
    const id = convInProject();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "ENG-3 do the thing", mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });
  });

  it("refuses to re-enter an already-moded existing chat", async () => {
    const id = convInProject();
    await enterModeOnSend(db(), id, "ticket", PROJECT_ID);
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "again", mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
