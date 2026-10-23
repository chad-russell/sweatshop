import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation, recordPendingInput } from "../db/chat";
import { pendingInputs } from "../db/schema";
import { POST } from "../app/api/x/input/route";

/**
 * 0081: POST /api/x/input's `answers` path — cross-checked against the
 * stored AskOwnerCard BEFORE chatApprovalHook.resume is ever called, so
 * a malformed submission 400s with the pending row untouched. Same
 * route-handler-direct style as tests/prompt-settings-api.test.ts.
 */

const singleCard = {
  kind: "ask_owner" as const,
  questions: [
    {
      id: "scope",
      header: "Scope",
      type: "single" as const,
      allowOther: true,
      options: [
        { id: "a", label: "Instructions block only" },
        { id: "b", label: "Instructions + validation" },
      ],
    },
  ],
};

function seed(id: string, card?: unknown) {
  const cid = `c_x_input_${id}`;
  ensureConversation(db(), cid);
  recordPendingInput(db(), { id, conversationId: cid, kind: "question", question: "Which?", ...(card !== undefined ? { card } : {}) });
  return cid;
}

const post = (body: unknown) =>
  POST(new Request("http://x/api/x/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/x/input: structured answers", () => {
  it("400s on an unknown option id — the row stays unresolved", async () => {
    seed("call_x1", singleCard);
    const res = await post({ toolCallId: "call_x1", answers: { scope: { selected: ["zzz"] } } });
    expect(res.status).toBe(400);
    const row = db().select().from(pendingInputs).where(eq(pendingInputs.id, "call_x1")).get()!;
    expect(row.resolvedAt).toBeNull();
  });

  it("400s when answers target a non-structured (legacy) pending row", async () => {
    seed("call_x2");
    const res = await post({ toolCallId: "call_x2", answers: { scope: { selected: ["a"] } } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("no structured question");
  });

  it("400s when neither approved, answer, nor answers is given", async () => {
    seed("call_x3", singleCard);
    const res = await post({ toolCallId: "call_x3" });
    expect(res.status).toBe(400);
  });

  it("a valid answer passes validation, attempts resume, and resolves the row as orphaned when no hook is live", async () => {
    seed("call_x4", singleCard);
    const res = await post({ toolCallId: "call_x4", answers: { scope: { selected: ["a"] } } });
    // No real workflow is suspended on this token in this test — the
    // resume throws "Hook not found," which the route treats as the
    // card outliving its hook (same fallback approvals/questions use)
    // rather than a 409, since validation already proved the shape was
    // fine.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumed?: boolean; cleared?: boolean };
    expect(body).toEqual({ resumed: false, cleared: true });
    const row = db().select().from(pendingInputs).where(eq(pendingInputs.id, "call_x4")).get()!;
    expect(row.resolvedAt).not.toBeNull();
    expect(JSON.parse(row.answer!)).toMatchObject({ kind: "question", answers: { scope: { selected: ["a"] } }, orphaned: "hook-gone" });
  });
});
