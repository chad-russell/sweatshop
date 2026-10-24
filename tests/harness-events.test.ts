import { describe, expect, it } from "vitest";
import {
  claimHarnessRun,
  countToolCalls,
  clipHarnessText,
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
  laneSessionId,
  listActiveHarnessRuns,
  listHarnessRuns,
  MAX_CONCURRENT_HARNESSES,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "../lib/harness-events";
import { LANE_BRIDGE_PORTS } from "../lib/sandboxes/harness-bridge";


describe("harness event store (0006)", () => {
  it("keeps events isolated per harness within one conversation", () => {
    recordHarnessEvent("wrun_h1", "pi", { kind: "start" });
    recordHarnessEvent("wrun_h1", "claude", { kind: "start" });
    recordHarnessEvent("wrun_h1", "claude", {
      kind: "tool-start",
      toolName: "bash",
    });

    const pi = getHarnessEvents("wrun_h1", "pi").events;
    const claude = getHarnessEvents("wrun_h1", "claude").events;
    expect(pi).toHaveLength(1);
    expect(claude).toHaveLength(2);
    expect(claude[1].toolName).toBe("bash");
  });

  it("round-trips toolCallId and tool-error rows", () => {
    recordHarnessEvent("wrun_h3", "pi", { kind: "tool-start", toolName: "write", toolCallId: "tc1" });
    recordHarnessEvent("wrun_h3", "pi", { kind: "tool-error", toolName: "write", toolCallId: "tc1", output: "boom" });
    const events = getHarnessEvents("wrun_h3", "pi").events;
    expect(events.map((e) => [e.kind, e.toolCallId])).toEqual([
      ["tool-start", "tc1"],
      ["tool-error", "tc1"],
    ]);
  });

  it("fromAt/toAt scope events to one call's window, inclusive (0046)", async () => {
    const { db } = await import("../db");
    const { harnessEvents } = await import("../db/schema");
    for (const at of [100, 200, 300, 400]) {
      db().insert(harnessEvents).values({ sessionId: "wrun_hw", harness: "pi", at, kind: "step-end", text: `t${at}` }).run();
    }
    const texts = (o: { fromAt?: number; toAt?: number }) =>
      getHarnessEvents("wrun_hw", "pi", o).events.map((e) => e.text);
    expect(texts({ fromAt: 200, toAt: 300 })).toEqual(["t200", "t300"]);
    expect(texts({ fromAt: 300 })).toEqual(["t300", "t400"]);
    expect(texts({ toAt: 100 })).toEqual(["t100"]);
  });

  it("tail returns the newest events, oldest-first", () => {
    for (let i = 0; i < 6; i += 1) {
      recordHarnessEvent("wrun_h4", "pi", { kind: "step-end", text: `t${i}` });
    }
    const page = getHarnessEvents("wrun_h4", "pi", { limit: 3, tail: true });
    expect(page.events.map((e) => e.text)).toEqual(["t3", "t4", "t5"]);
  });

  it("pages events with an id cursor", () => {
    for (let i = 0; i < 7; i += 1) {
      recordHarnessEvent("wrun_h2", "pi", { kind: "step-start" });
    }
    const first = getHarnessEvents("wrun_h2", "pi", { limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.cursor).toBe(first.events[2].id);

    const rest = getHarnessEvents("wrun_h2", "pi", {
      afterId: first.cursor!,
      limit: 100,
    });
    expect(rest.events).toHaveLength(4);
    expect(rest.cursor).toBeNull();
    expect(rest.events[0].id).toBe(first.cursor! + 1);
  });

  it("different kinds claim their own slot concurrently; the same kind is refused while running", () => {
    expect(claimHarnessRun("wrun_h3", "claude")).toMatchObject({ ok: true });
    expect(listActiveHarnessRuns("wrun_h3").map((r) => r.kind)).toEqual(["claude"]);

    // A re-claim of the SAME kind is refused while its run is live...
    const sameKind = claimHarnessRun("wrun_h3", "claude");
    expect(sameKind).toMatchObject({ ok: false, reason: "same-kind" });
    if (!sameKind.ok) expect(sameKind.active.map((r) => r.kind)).toEqual(["claude"]);

    // ...but a DIFFERENT kind may run alongside it (0038 amendment).
    expect(claimHarnessRun("wrun_h3", "pi")).toMatchObject({ ok: true });
    expect(listActiveHarnessRuns("wrun_h3").map((r) => r.kind).sort()).toEqual(["claude", "pi"]);

    recordHarnessRunEnd("wrun_h3", "claude", 4, "failed", "boom");
    const run = getHarnessRun("wrun_h3", "claude");
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("boom");
    expect(run?.toolCalls).toBe(4);
    expect(listActiveHarnessRuns("wrun_h3").map((r) => r.kind)).toEqual(["pi"]);

    // claude's slot is free again — it (or any other kind) may claim it;
    // other conversations are unaffected.
    expect(claimHarnessRun("wrun_h3", "claude")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_h3b", "claude")).toMatchObject({ ok: true });
  });

  it("caps total concurrent runs at MAX_CONCURRENT_HARNESSES regardless of kind", () => {
    expect(claimHarnessRun("wrun_cap", "pi")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_cap", "claude")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_cap", "cursor")).toMatchObject({ ok: true });
    expect(listActiveHarnessRuns("wrun_cap")).toHaveLength(MAX_CONCURRENT_HARNESSES);

    // A fourth concurrent kind — codex, real since 0050 made the roster
    // four against a cap of three — hits the cap, distinct from a
    // same-kind collision.
    const fourth = claimHarnessRun("wrun_cap", "codex");
    expect(fourth).toMatchObject({ ok: false, reason: "cap" });
    if (!fourth.ok) expect(fourth.active).toHaveLength(3);
  });

  it("resets run counters and error when re-claiming after a failed run", () => {
    recordHarnessRunEnd("wrun_h4", "pi", 1, "failed", "earlier failure");
    expect(claimHarnessRun("wrun_h4", "pi")).toMatchObject({ ok: true });
    const run = getHarnessRun("wrun_h4", "pi");
    expect(run?.status).toBe("running");
    expect(run?.error).toBeNull();
    expect(run?.toolCalls).toBe(0);
  });

  it("clips stored error text and lists latest run per harness", () => {
    const long = "x".repeat(600);
    recordHarnessRunEnd("wrun_h5", "claude", 0, "failed", long);
    const errorText = getHarnessRun("wrun_h5", "claude")?.error;
    expect(errorText?.length).toBeLessThanOrEqual(501);

    claimHarnessRun("wrun_h5", "pi");
    const runs = listHarnessRuns("wrun_h5");
    expect(runs.map((r) => r.kind).sort()).toEqual(["claude", "pi"]);
  });

  it("validates harness kinds", () => {
    expect(isHarnessKind("pi")).toBe(true);
    expect(isHarnessKind("claude")).toBe(true);
    expect(isHarnessKind("codex")).toBe(true);
    expect(isHarnessKind("gloo")).toBe(false);
  });

  it("clips event payloads through the shared helper", () => {
    const clipped = clipHarnessText("y".repeat(3000), 100);
    expect(clipped?.length).toBeLessThanOrEqual(101);
    expect(clipHarnessText(undefined)).toBeUndefined();
  });
});

describe("countToolCalls (machine-stage settle)", () => {
  it("counts a session's tool-start events, not the claim's zero", () => {
    claimHarnessRun("mr_cnt_0", "pi");
    for (let i = 0; i < 3; i++) {
      recordHarnessEvent("mr_cnt_0", "pi", { kind: "tool-start", toolName: "bash", input: "x" });
      recordHarnessEvent("mr_cnt_0", "pi", { kind: "tool-end", toolName: "bash", output: "y" });
    }
    recordHarnessEvent("mr_cnt_0", "pi", { kind: "step-end" });
    expect(countToolCalls("mr_cnt_0", "pi")).toBe(3);
    recordHarnessRunEnd("mr_cnt_0", "pi", countToolCalls("mr_cnt_0", "pi"), "completed");
    expect(getHarnessRun("mr_cnt_0", "pi")?.toolCalls).toBe(3);
  });
});

describe("harness event paging backwards (load earlier)", () => {
  it("tail reports hasOlder; before pages older events oldest-first", () => {
    for (let i = 0; i < 7; i += 1) {
      recordHarnessEvent("wrun_hb", "pi", { kind: "step-end", text: `t${i}` });
    }
    const tail = getHarnessEvents("wrun_hb", "pi", { limit: 3, tail: true });
    expect(tail.events.map((e) => e.text)).toEqual(["t4", "t5", "t6"]);
    expect(tail.hasOlder).toBe(true);

    const mid = getHarnessEvents("wrun_hb", "pi", { limit: 3, beforeId: tail.events[0].id });
    expect(mid.events.map((e) => e.text)).toEqual(["t1", "t2", "t3"]);
    expect(mid.hasOlder).toBe(true);

    const first = getHarnessEvents("wrun_hb", "pi", { limit: 3, beforeId: mid.events[0].id });
    expect(first.events.map((e) => e.text)).toEqual(["t0"]);
    expect(first.hasOlder).toBe(false);
  });

  it("an exactly-full tail has no older events", () => {
    for (let i = 0; i < 3; i += 1) recordHarnessEvent("wrun_hb2", "pi", { kind: "step-end" });
    expect(getHarnessEvents("wrun_hb2", "pi", { limit: 3, tail: true }).hasOlder).toBe(false);
  });

  it("before stays inside the call's from/to window", async () => {
    const { db } = await import("../db");
    const { harnessEvents } = await import("../db/schema");
    for (const at of [100, 200, 300, 400, 500]) {
      db().insert(harnessEvents).values({ sessionId: "wrun_hbw", harness: "pi", at, kind: "step-end", text: `t${at}` }).run();
    }
    const tail = getHarnessEvents("wrun_hbw", "pi", { limit: 2, tail: true, fromAt: 200, toAt: 400 });
    expect(tail.events.map((e) => e.text)).toEqual(["t300", "t400"]);
    const older = getHarnessEvents("wrun_hbw", "pi", { limit: 2, beforeId: tail.events[0].id, fromAt: 200, toAt: 400 });
    expect(older.events.map((e) => e.text)).toEqual(["t200"]);
    expect(older.hasOlder).toBe(false);
  });
});

describe("0083 harness lanes: claimHarnessRun", () => {
  it("a lane collides with another call at the SAME dir, but not with the default lane or a different dir", () => {
    expect(claimHarnessRun("wrun_lane1", "pi")).toMatchObject({ ok: true }); // default lane
    expect(claimHarnessRun("wrun_lane1", "pi", "wt/a")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_lane1", "pi", "wt/b")).toMatchObject({ ok: true });
    expect(listActiveHarnessRuns("wrun_lane1").map((r) => r.dir).sort()).toEqual(["", "wt/a", "wt/b"]);

    // Same dir again while it's running: refused.
    const collide = claimHarnessRun("wrun_lane1", "pi", "wt/a");
    expect(collide).toMatchObject({ ok: false, reason: "same-kind" });

    recordHarnessRunEnd("wrun_lane1", "pi", 0, "completed", undefined, "wt/a");
    expect(claimHarnessRun("wrun_lane1", "pi", "wt/a")).toMatchObject({ ok: true });
  });

  it("the default lane collides with itself, same as pre-0083", () => {
    expect(claimHarnessRun("wrun_lane2", "claude")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_lane2", "claude")).toMatchObject({ ok: false, reason: "same-kind" });
  });

  it("the cap is enforced across lanes, regardless of dir", () => {
    expect(claimHarnessRun("wrun_lane_cap", "pi", "wt/a")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_lane_cap", "pi", "wt/b")).toMatchObject({ ok: true });
    expect(claimHarnessRun("wrun_lane_cap", "pi", "wt/c")).toMatchObject({ ok: true });
    expect(listActiveHarnessRuns("wrun_lane_cap")).toHaveLength(MAX_CONCURRENT_HARNESSES);
    const fourth = claimHarnessRun("wrun_lane_cap", "pi", "wt/d");
    expect(fourth).toMatchObject({ ok: false, reason: "cap" });
  });

  it("grants a lane bridge port to a bridge-backed lane, never to pi or the default lane", () => {
    const piLane = claimHarnessRun("wrun_lane_port0", "pi", "wt/a");
    expect(piLane).toMatchObject({ ok: true });
    if (piLane.ok) expect(piLane.port).toBeUndefined();
    expect(getHarnessRun("wrun_lane_port0", "pi", "wt/a")?.port ?? null).toBeNull();

    expect(claimHarnessRun("wrun_lane_port0", "claude")).toMatchObject({ ok: true }); // default lane
    expect(getHarnessRun("wrun_lane_port0", "claude")?.port ?? null).toBeNull();

    const lane = claimHarnessRun("wrun_lane_port0", "claude", "wt/a");
    expect(lane).toMatchObject({ ok: true });
    if (lane.ok) expect(LANE_BRIDGE_PORTS).toContain(lane.port);
  });

  // Exhausting all LANE_BRIDGE_PORTS within ONE conversation is
  // impossible to observe here: the pool has one more port (4) than
  // MAX_CONCURRENT_HARNESSES (3), so a single conversation's own cap
  // always blocks a 4th claim first. Real exhaustion needs the pool's
  // actual scope — shared across conversations on the SAME sandbox (an
  // attached child thread) — covered in tests/harness-calls.test.ts,
  // which has the conversation/sandbox fixtures this needs.

  it("releasing a lane (recordHarnessRunEnd) frees its port for the next lane", () => {
    const conv = "wrun_lane_port2";
    const first = claimHarnessRun(conv, "claude", "wt/a");
    expect(first).toMatchObject({ ok: true });
    const port = first.ok ? first.port : undefined;
    recordHarnessRunEnd(conv, "claude", 0, "completed", undefined, "wt/a");
    expect(getHarnessRun(conv, "claude", "wt/a")?.port ?? null).toBeNull();
    const second = claimHarnessRun(conv, "cursor", "wt/b");
    expect(second).toMatchObject({ ok: true, port });
  });
});

describe("laneSessionId (0083)", () => {
  it("is stable, distinct per dir, and contains no '/'", () => {
    const a = laneSessionId("c_123", "wt/approvals");
    const b = laneSessionId("c_123", "wt/approvals");
    const c = laneSessionId("c_123", "wt/other");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("/");
    expect(a.startsWith("c_123-")).toBe(true);
  });
});
