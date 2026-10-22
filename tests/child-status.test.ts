import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDb } from "../db";
import { appendMessages, ensureConversation, setActiveRun, setConversationParent, setConversationWorkStep } from "../db/chat";
import { createHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { conversations, projects } from "../db/schema";
import { childStatus, childThreadStatusLabels } from "../lib/child-status";

/** The transcript cards' live status read model (hc_… and c_…; mr_… is
 *  permanently not-found since 0048 purged machine runs). */

const tdb = openDb(process.env.SWEATSHOP_DB!);
tdb.insert(projects).values({ id: "p_cs", name: "CS", createdAt: 0 }).onConflictDoNothing().run();
ensureConversation(tdb, "c_cs", "p_cs");
describe("childStatus", () => {
  it("unknown and foreign ids are null", () => {
    expect(childStatus(tdb, "mr_nope")).toBeNull();
    expect(childStatus(tdb, "hc_nope")).toBeNull();
    expect(childStatus(tdb, "c_cs")).toBeNull(); // not a child thread
    expect(childStatus(tdb, "sbx_nope")).toBeNull();
  });

  it("a harness call is live while running and final once settled", () => {
    const call = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t" });
    expect(childStatus(tdb, call.id)).toMatchObject({
      kind: "harness",
      status: "running",
      live: true,
      href: `/h/pi/c_cs/${call.id}`,
      settledAt: null,
    });
    settleHarnessCall(tdb, call.id, { status: "failed", error: "boom" });
    expect(childStatus(tdb, call.id)).toMatchObject({ status: "failed", live: false, error: "boom" });
  });

  it("a cancelled call is never live, even though settledAt is now stamped too", () => {
    const call = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t" });
    settleHarnessCall(tdb, call.id, { status: "cancelled" });
    expect(childStatus(tdb, call.id)).toMatchObject({
      status: "cancelled",
      live: false,
      settledAt: expect.any(Number),
    });
  });

  it("a child thread is live while its turn is (0037 phase 3)", () => {
    ensureConversation(tdb, "c_cs_parent", "p_cs");
    ensureConversation(tdb, "c_cs_child", "p_cs");
    setConversationParent(tdb, "c_cs_child", "c_cs_parent");
    setActiveRun(tdb, "c_cs_child", "wr_cs");
    expect(childStatus(tdb, "c_cs_child")).toMatchObject({
      kind: "thread",
      status: "running",
      live: true,
      where: null, // no skill
      href: "/c/c_cs_child",
      settledAt: null,
    });
    setActiveRun(tdb, "c_cs_child", null);
    expect(childStatus(tdb, "c_cs_child")).toMatchObject({ status: "completed", live: false, settledAt: expect.any(Number) });
  });

  it("exposes the recorded outline step for both worker kinds", () => {
    const call = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t", step: "QA" });
    expect(childStatus(tdb, call.id)).toMatchObject({ phase: "QA" });

    const noPhaseCall = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t" });
    expect(childStatus(tdb, noPhaseCall.id)).toMatchObject({ phase: null });

    ensureConversation(tdb, "c_cs_parent2", "p_cs");
    ensureConversation(tdb, "c_cs_child2", "p_cs");
    setConversationParent(tdb, "c_cs_child2", "c_cs_parent2");
    setConversationWorkStep(tdb, "c_cs_child2", "Implement");
    expect(childStatus(tdb, "c_cs_child2")).toMatchObject({ phase: "Implement" });
  });
});

function statusMessage(id: string, steps: { label: string; state: "pending" | "active" | "done" }[]) {
  return {
    id,
    role: "tool" as const,
    text: "",
    modelMessage: {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: id,
          toolName: "update_status",
          output: { type: "json" as const, value: { ok: true as const, steps } },
        },
      ],
    },
  };
}

describe("childThreadStatusLabels", () => {
  it("uses the newest update_status row and skips trashed and archived children", () => {
    ensureConversation(tdb, "c_cs_lbl_parent", "p_cs");
    ensureConversation(tdb, "c_cs_lbl_live", "p_cs");
    ensureConversation(tdb, "c_cs_lbl_trash", "p_cs");
    ensureConversation(tdb, "c_cs_lbl_arch", "p_cs");
    setConversationParent(tdb, "c_cs_lbl_live", "c_cs_lbl_parent");
    setConversationParent(tdb, "c_cs_lbl_trash", "c_cs_lbl_parent");
    setConversationParent(tdb, "c_cs_lbl_arch", "c_cs_lbl_parent");
    appendMessages(tdb, "c_cs_lbl_live", [
      statusMessage("m_lbl_old", [{ label: "Plan", state: "active" }]),
      statusMessage("m_lbl_new", [
        { label: "Plan", state: "done" },
        { label: "Implement", state: "active" },
      ]),
      { id: "m_lbl_chat", role: "assistant", text: "noted", modelMessage: { role: "assistant", content: "noted" } },
    ]);
    appendMessages(tdb, "c_cs_lbl_trash", [statusMessage("m_lbl_trash", [{ label: "Ship", state: "active" }])]);
    appendMessages(tdb, "c_cs_lbl_arch", [statusMessage("m_lbl_arch", [{ label: "Review", state: "active" }])]);
    tdb.update(conversations).set({ trashedAt: 1 }).where(eq(conversations.id, "c_cs_lbl_trash")).run();
    tdb.update(conversations).set({ archivedAt: 1 }).where(eq(conversations.id, "c_cs_lbl_arch")).run();

    const labels = childThreadStatusLabels(tdb, ["c_cs_lbl_live", "c_cs_lbl_trash", "c_cs_lbl_arch"]);
    expect(labels.get("c_cs_lbl_live")).toBe("Implement · 1/2");
    expect(labels.has("c_cs_lbl_trash")).toBe(false);
    expect(labels.has("c_cs_lbl_arch")).toBe(false);
    expect(childStatus(tdb, "c_cs_lbl_live")?.statusLabel).toBe("Implement · 1/2");
    expect(childStatus(tdb, "c_cs_lbl_trash")?.statusLabel).toBe("Ship · 0/1");
  });
});
