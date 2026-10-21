import { describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getConversation } from "../db/chat";
import { projects } from "../db/schema";
import { enterTicketModeOnSend } from "../lib/chat/mode-entry";
import { POST as postChat } from "../app/api/x/chat/route";

/**
 * 0055 owner entry: `lib/chat/mode-entry.ts` (no approval — the owner's
 * own action) and the send route's `mode` field / legacy `?skill=ticket`
 * equivalence. `tests/mode-tools.test.ts` covers the agent's own
 * approval-gated `enter_mode` tool.
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

describe("enterTicketModeOnSend (owner entry, no approval)", () => {
  it("refuses without a project, writing nothing", async () => {
    const id = conv();
    const result = await enterTicketModeOnSend(db(), id, null);
    expect(result).toMatchObject({ ok: false, code: "no-project" });
    expect(getConversation(db(), id)?.skill).toBeNull();
  });

  it("refuses when already moded", async () => {
    const id = convInProject();
    const { setConversationSkill } = await import("../db/chat");
    setConversationSkill(db(), id, "ticket");
    const result = await enterTicketModeOnSend(db(), id, PROJECT_ID);
    expect(result).toMatchObject({ ok: false, code: "already-moded" });
  });

  it("writes skill + phase and appends a runEvent 'mode' row carrying the rendered runbook, with no approval step", async () => {
    const id = convInProject();
    const result = await enterTicketModeOnSend(db(), id, PROJECT_ID);
    expect(result).toMatchObject({ ok: true });
    expect(getConversation(db(), id)).toMatchObject({ skill: "ticket", modePhase: "plan" });

    const { listMessageTexts } = await import("../db/chat");
    const rows = listMessageTexts(db(), id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "user" });
    expect(rows[0]!.metadata).toMatchObject({ runEvent: { kind: "mode", id: "ticket", status: "entered" } });
    expect(rows[0]!.text).toContain("## plan");
    expect(rows[0]!.text).not.toContain("{{owner");
  });
});

describe("POST /api/x/chat: mode entry (0055)", () => {
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

  it("the legacy ?skill=ticket query param means the same thing as mode=ticket", async () => {
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

  it("refuses without a project, creating nothing", async () => {
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses an unknown mode name", async () => {
    ensureProject();
    const id = freshId();
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "hi", projectId: PROJECT_ID, mode: "sprint" }),
      }),
    );
    expect(res.status).toBe(400);
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
    await enterTicketModeOnSend(db(), id, PROJECT_ID);
    const res = await postChat(
      new Request("http://x/api/x/chat", {
        method: "POST",
        body: JSON.stringify({ conversationId: id, text: "again", mode: "ticket" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
