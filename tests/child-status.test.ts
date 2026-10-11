import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ensureConversation, setActiveRun, setConversationParent } from "../db/chat";
import { createHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { machineRuns } from "../db/schema";
import { projects } from "../db/schema";
import { childStatus } from "../lib/child-status";

/** The transcript cards' live status read model (mr_…, hc_…, and c_…). */

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
      href: "/h/pi/c_cs",
      settledAt: null,
    });
    settleHarnessCall(tdb, call.id, { status: "failed", error: "boom" });
    expect(childStatus(tdb, call.id)).toMatchObject({ status: "failed", live: false, error: "boom" });
  });

  it("a historical run reads (0037 phase 5: rows only, no writes)", () => {
    const def = JSON.stringify({ start: "a", stages: { a: { kind: "agent", title: "A", instructions: "a", next: [] } } });
    const at = { machineName: "CS", machineVersion: 1, definition: def, prompt: "go", createdAt: 1, updatedAt: 1 };
    tdb.insert(machineRuns).values({ id: "mr_cs_live", status: "running", currentStage: "a", ...at }).run();
    tdb.insert(machineRuns).values({ id: "mr_cs_done", status: "completed", currentStage: null, settledAt: 5, ...at }).run();
    expect(childStatus(tdb, "mr_cs_live")).toMatchObject({ kind: "run", status: "running", live: true, where: "a", href: "/r/mr_cs_live" });
    const done = childStatus(tdb, "mr_cs_done");
    expect(done).toMatchObject({ status: "completed", live: false, where: null });
    expect(done?.settledAt).toBe(5);
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
});
