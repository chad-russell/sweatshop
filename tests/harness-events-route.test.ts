import { describe, expect, it } from "vitest";
import { GET } from "../app/api/harness/[sessionId]/route";
import { recordHarnessEvent } from "../lib/harness-events";
import { buildTimeline } from "../lib/harness-timeline";

const get = (sessionId: string, query: string) =>
  GET(new Request(`http://x/api/harness/${sessionId}?${query}`), { params: Promise.resolve({ sessionId }) });

type Body = { events: { id: number; text: string | null }[]; hasOlder?: boolean };

describe("GET /api/harness/[sessionId] paging", () => {
  it("?tail= then ?before= pages backwards with hasOlder", async () => {
    for (let i = 0; i < 5; i += 1) recordHarnessEvent("wrun_rt", "pi", { kind: "step-end", text: `t${i}` });
    const tail = (await (await get("wrun_rt", "harness=pi&tail=2")).json()) as Body;
    expect(tail.events.map((e) => e.text)).toEqual(["t3", "t4"]);
    expect(tail.hasOlder).toBe(true);
    const older = (await (await get("wrun_rt", `harness=pi&tail=2&before=${tail.events[0].id}`)).json()) as Body;
    expect(older.events.map((e) => e.text)).toEqual(["t1", "t2"]);
    expect(older.hasOlder).toBe(true);
  });

  it("a page cut between tool-start and tool-end folds without garbage", async () => {
    recordHarnessEvent("wrun_rt2", "pi", { kind: "tool-start", toolName: "bash", toolCallId: "a", input: "{}" });
    recordHarnessEvent("wrun_rt2", "pi", { kind: "tool-end", toolName: "bash", toolCallId: "a", output: "ok" });
    const tail = (await (await get("wrun_rt2", "harness=pi&tail=1")).json()) as Body;
    const orphan = buildTimeline(tail.events as never);
    expect(orphan).toMatchObject([{ type: "tool", toolName: "bash", state: "completed", input: null }]);
    const older = (await (await get("wrun_rt2", `harness=pi&tail=1&before=${tail.events[0].id}`)).json()) as Body;
    const merged = buildTimeline([...older.events, ...tail.events] as never);
    expect(merged).toMatchObject([{ type: "tool", state: "completed", input: "{}", output: "ok" }]);
  });
});
