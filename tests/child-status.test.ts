import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ensureConversation, setActiveRun, setConversationParent, setConversationWorkPhase } from "../db/chat";
import { createHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { projects } from "../db/schema";
import { childStatus } from "../lib/child-status";

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

  it("0055 v7 part B: exposes the recorded phase for both kinds, null when none", () => {
    const call = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t", phase: "QA" });
    expect(childStatus(tdb, call.id)).toMatchObject({ phase: "QA" });

    const noPhaseCall = createHarnessCall(tdb, { conversationId: "c_cs", kind: "pi", task: "t" });
    expect(childStatus(tdb, noPhaseCall.id)).toMatchObject({ phase: null });

    ensureConversation(tdb, "c_cs_parent2", "p_cs");
    ensureConversation(tdb, "c_cs_child2", "p_cs");
    setConversationParent(tdb, "c_cs_child2", "c_cs_parent2");
    setConversationWorkPhase(tdb, "c_cs_child2", "Implement");
    expect(childStatus(tdb, "c_cs_child2")).toMatchObject({ phase: "Implement" });
  });
});
