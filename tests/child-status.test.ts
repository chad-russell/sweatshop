import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { ensureConversation } from "../db/chat";
import { createHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { createMachine, createRun, updateRun } from "../db/machines";
import { projects } from "../db/schema";
import { childStatus } from "../lib/child-status";

/** The transcript cards' live status read model (mr_… and hc_…). */

const tdb = openDb(process.env.SWEATSHOP_DB!);
tdb.insert(projects).values({ id: "p_cs", name: "CS", createdAt: 0 }).onConflictDoNothing().run();
ensureConversation(tdb, "c_cs", "p_cs");
createMachine(tdb, {
  id: "cs-machine",
  name: "CS",
  definition: { workspace: "none", start: "a", stages: { a: { kind: "agent", title: "A", instructions: "a", next: [] } } },
});

describe("childStatus", () => {
  it("unknown and foreign ids are null", () => {
    expect(childStatus(tdb, "mr_nope")).toBeNull();
    expect(childStatus(tdb, "hc_nope")).toBeNull();
    expect(childStatus(tdb, "c_cs")).toBeNull();
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

  it("a run is live while running or waiting at a gate, settled otherwise", () => {
    const run = createRun(tdb, { machineId: "cs-machine", prompt: "go" });
    updateRun(tdb, run.id, { status: "running", currentStage: "a" });
    expect(childStatus(tdb, run.id)).toMatchObject({ kind: "run", status: "running", live: true, stage: "a", href: `/r/${run.id}` });
    updateRun(tdb, run.id, { status: "waiting" });
    expect(childStatus(tdb, run.id)).toMatchObject({ status: "waiting", live: true });
    updateRun(tdb, run.id, { status: "completed", currentStage: null });
    const done = childStatus(tdb, run.id);
    expect(done).toMatchObject({ status: "completed", live: false, stage: null });
    expect(done?.settledAt).toEqual(expect.any(Number));
  });
});
