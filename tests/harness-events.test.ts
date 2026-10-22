import { describe, expect, it } from "vitest";
import { GET as getHarnessSession } from "../app/api/harness/[sessionId]/route";
import {
  claimHarnessRun,
  countToolCalls,
  clipHarnessText,
  getHarnessEvents,
  getHarnessRun,
  isHarnessKind,
  listActiveHarnessRuns,
  listHarnessRuns,
  MAX_CONCURRENT_HARNESSES,
  recordHarnessEvent,
  recordHarnessRunEnd,
} from "../lib/harness-events";


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

  it("tail reports the older rows left and the cursor for them (0075)", () => {
    for (let i = 0; i < 6; i += 1) {
      recordHarnessEvent("wrun_ht2", "pi", { kind: "step-end", text: `t${i}` });
    }
    const page = getHarnessEvents("wrun_ht2", "pi", { limit: 3, tail: true });
    expect(page.events.map((e) => e.text)).toEqual(["t3", "t4", "t5"]);
    expect(page.remaining).toBe(3);
    expect(page.cursor).toBe(page.events[0].id);
    // A window that holds every row: no older rows, no cursor.
    const all = getHarnessEvents("wrun_ht2", "pi", { limit: 10, tail: true });
    expect(all.remaining).toBe(0);
    expect(all.cursor).toBeNull();
  });

  it("beforeId pages older events oldest-first, exhausting to a null cursor (0075)", () => {
    for (let i = 0; i < 7; i += 1) {
      recordHarnessEvent("wrun_hb", "pi", { kind: "step-end", text: `t${i}` });
    }
    const tail = getHarnessEvents("wrun_hb", "pi", { limit: 3, tail: true });
    expect(tail.events.map((e) => e.text)).toEqual(["t4", "t5", "t6"]);

    const page1 = getHarnessEvents("wrun_hb", "pi", { beforeId: tail.cursor!, limit: 3 });
    expect(page1.events.map((e) => e.text)).toEqual(["t1", "t2", "t3"]);
    expect(page1.remaining).toBe(1);
    expect(page1.cursor).toBe(page1.events[0].id);

    const page2 = getHarnessEvents("wrun_hb", "pi", { beforeId: page1.cursor!, limit: 3 });
    expect(page2.events.map((e) => e.text)).toEqual(["t0"]);
    expect(page2.cursor).toBeNull();
    expect(page2.remaining).toBe(0);

    // Strictly below the very first row: an empty page, still exhausted.
    const page3 = getHarnessEvents("wrun_hb", "pi", { beforeId: page2.events[0].id, limit: 3 });
    expect(page3.events).toHaveLength(0);
    expect(page3.cursor).toBeNull();
    expect(page3.remaining).toBe(0);
  });

  it("tail and beforeId compose with fromAt/toAt windows (0075)", async () => {
    const { db } = await import("../db");
    const { harnessEvents } = await import("../db/schema");
    for (const at of [100, 200, 300, 400, 500, 600, 700, 800]) {
      db()
        .insert(harnessEvents)
        .values({ sessionId: "wrun_htw", harness: "pi", at, kind: "step-end", text: `a${at}` })
        .run();
    }
    const page = getHarnessEvents("wrun_htw", "pi", {
      limit: 2,
      tail: true,
      fromAt: 300,
      toAt: 600,
    });
    expect(page.events.map((e) => e.text)).toEqual(["a500", "a600"]);
    expect(page.remaining).toBe(2);
    expect(page.cursor).toBe(page.events[0].id);

    const older = getHarnessEvents("wrun_htw", "pi", {
      limit: 2,
      beforeId: page.cursor!,
      fromAt: 300,
      toAt: 600,
    });
    expect(older.events.map((e) => e.text)).toEqual(["a300", "a400"]);
    expect(older.cursor).toBeNull();
    expect(older.remaining).toBe(0);
  });

  it("forward pages keep their cursor semantics and report newer rows remaining", () => {
    for (let i = 0; i < 5; i += 1) {
      recordHarnessEvent("wrun_hf", "pi", { kind: "step-start" });
    }
    const first = getHarnessEvents("wrun_hf", "pi", { limit: 2 });
    expect(first.cursor).toBe(first.events[1].id);
    expect(first.remaining).toBe(3);
    const rest = getHarnessEvents("wrun_hf", "pi", { afterId: first.cursor!, limit: 2 });
    expect(rest.remaining).toBe(1);
    const last = getHarnessEvents("wrun_hf", "pi", { afterId: rest.cursor!, limit: 2 });
    expect(last.events).toHaveLength(1);
    expect(last.cursor).toBeNull();
    expect(last.remaining).toBe(0);
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

describe("GET /api/harness/[sessionId] ?before paging (0075)", () => {
  it("tail and before pages carry cursor + remaining end to end", async () => {
    const { db } = await import("../db");
    const { harnessEvents } = await import("../db/schema");
    for (let i = 0; i < 5; i += 1) {
      db()
        .insert(harnessEvents)
        .values({ sessionId: "wrun_hr", harness: "pi", at: 100 + i, kind: "step-end", text: `r${i}` })
        .run();
    }
    const get = (query: string) =>
      getHarnessSession(new Request(`http://x/api/harness/wrun_hr?${query}`), {
        params: Promise.resolve({ sessionId: "wrun_hr" }),
      });

    const tailRes = await get("harness=pi&tail=2");
    expect(tailRes.status).toBe(200);
    const tail = (await tailRes.json()) as {
      events: { text: string }[];
      cursor: number;
      remaining: number;
    };
    expect(tail.events.map((e) => e.text)).toEqual(["r3", "r4"]);
    expect(tail.remaining).toBe(3);

    const prevRes = await get(`harness=pi&before=${tail.cursor}`);
    expect(prevRes.status).toBe(200);
    const prev = (await prevRes.json()) as {
      events: { text: string }[];
      cursor: number | null;
      remaining: number;
    };
    expect(prev.events.map((e) => e.text)).toEqual(["r0", "r1", "r2"]);
    expect(prev.cursor).toBeNull();
    expect(prev.remaining).toBe(0);
  });
});
