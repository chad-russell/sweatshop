import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ensureConversation, recordPendingInput, resolveOrphanedPendingInputs } from "../db/chat";
import { messages, projects } from "../db/schema";

/**
 * 0043 sharp edge: a turn cancelled (or crashed) while suspended on an
 * approval never persisted its slice — the transcript showed nothing of
 * the ask it died on. The orphan resolution now leaves one assistant
 * note row per orphaned pending (plain text: no dangling tool-calls for
 * the next model call).
 */

const PROJECT = "p_orphan";
db().insert(projects).values({ id: PROJECT, name: "Orphan", createdAt: 0 }).onConflictDoNothing().run();

describe("resolveOrphanedPendingInputs", () => {
  it("leaves a stopped-note row per orphaned ask, once", () => {
    const id = "c_orphan_1";
    ensureConversation(db(), id, PROJECT);
    recordPendingInput(db(), {
      id: "call_exec_orph",
      conversationId: id,
      kind: "approval",
      question: "exec on bee — crussell@10.10.0.12 (120s timeout)\n\n$ hostname && uptime",
    });
    recordPendingInput(db(), { id: "call_q_orph", conversationId: id, kind: "question", question: "which host?" });

    const cleared = resolveOrphanedPendingInputs(db(), id, "cancelled");
    expect(cleared.sort()).toEqual(["call_exec_orph", "call_q_orph"]);

    const rows = db().select().from(messages).where(eq(messages.conversationId, id)).all();
    const notes = rows.filter((r) => r.id.startsWith("cx_"));
    expect(notes).toHaveLength(2);
    expect(notes.map((r) => r.id).sort()).toEqual([`cx_${id}_call_exec_orph`, `cx_${id}_call_q_orph`].sort());
    const execNote = notes.find((r) => r.id.includes("exec"));
    expect(execNote?.text).toContain("[stopped — cancelled]");
    expect(execNote?.text).toContain("was waiting on your approval");
    expect(execNote?.text).toContain("hostname && uptime");
    expect(execNote?.role).toBe("assistant");

    // Idempotent: a second sweep resolves nothing and adds no rows.
    expect(resolveOrphanedPendingInputs(db(), id, "run-ended")).toEqual([]);
    expect(db().select().from(messages).where(eq(messages.conversationId, id)).all()).toHaveLength(rows.length);
  });
});
