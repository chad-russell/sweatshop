import { describe, expect, it } from "vitest";
import { buildTimeline, summarizeActivity, toolBrief, type TimelineEvent } from "../lib/harness-timeline";

let n = 0;
const ev = (e: Omit<TimelineEvent, "id">): TimelineEvent => ({ id: ++n, ...e });

describe("buildTimeline", () => {
  it("carries the task a turn was given (older start rows have none)", () => {
    const items = buildTimeline([
      ev({ kind: "start", input: "Create post-deploy.txt" }),
      ev({ kind: "end" }),
      ev({ kind: "start" }),
    ]);
    expect(items[0]).toMatchObject({ type: "turn-start", task: "Create post-deploy.txt" });
    expect(items[2]).toMatchObject({ type: "turn-start", task: null });
  });

  it("folds start + end into one tool item by toolCallId", () => {
    const items = buildTimeline([
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "a", input: "{}" }),
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "b", input: "{}" }),
      ev({ kind: "tool-end", toolName: "bash", toolCallId: "b", output: "two" }),
      ev({ kind: "tool-end", toolName: "bash", toolCallId: "a", output: "one" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ toolCallId: "a", state: "completed", output: "one" });
    expect(items[1]).toMatchObject({ toolCallId: "b", state: "completed", output: "two" });
  });

  it("leaves an unfinished call running and marks errors", () => {
    const items = buildTimeline([
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "a" }),
      ev({ kind: "tool-start", toolName: "write", toolCallId: "b" }),
      ev({ kind: "tool-error", toolName: "write", toolCallId: "b", output: "EACCES" }),
    ]);
    expect(items[0]).toMatchObject({ state: "running" });
    expect(items[1]).toMatchObject({ state: "error", output: "EACCES" });
  });

  it("attaches a fileChange to the running write on that path", () => {
    const items = buildTimeline([
      ev({ kind: "tool-start", toolName: "write", toolCallId: "w", input: '{"path":"./scratch/smoke.txt","content":"x"}' }),
      ev({ kind: "tool-start", toolName: "fileChange", toolCallId: "f", input: '{"event":"add","path":"scratch/smoke.txt"}' }),
      ev({ kind: "tool-end", toolName: "fileChange", toolCallId: "f", output: '{"event":"add","path":"scratch/smoke.txt"}' }),
      ev({ kind: "tool-end", toolName: "write", toolCallId: "w", output: "ok" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "tool",
      toolName: "write",
      state: "completed",
      changes: [{ event: "add", path: "scratch/smoke.txt" }],
    });
  });

  it("shows an unmatched fileChange as its own marker", () => {
    const items = buildTimeline([
      ev({ kind: "tool-start", toolName: "fileChange", toolCallId: "f", input: '{"event":"update","path":"a.ts"}' }),
    ]);
    expect(items).toEqual([expect.objectContaining({ type: "file-change" })]);
  });

  it("pairs legacy rows (no toolCallId) with the earliest open start of that tool", () => {
    const items = buildTimeline([
      ev({ kind: "tool-start", toolName: "bash" }),
      ev({ kind: "tool-start", toolName: "write" }),
      ev({ kind: "tool-end", toolName: "bash", output: "done" }),
    ]);
    expect(items[0]).toMatchObject({ toolName: "bash", state: "completed" });
    expect(items[1]).toMatchObject({ toolName: "write", state: "running" });
  });

  it("renders compaction as a marker and keeps turn boundaries and text", () => {
    const items = buildTimeline([
      ev({ kind: "start" }),
      ev({ kind: "tool-start", toolName: "compaction", toolCallId: "c" }),
      ev({ kind: "tool-end", toolName: "compaction", toolCallId: "c", output: "{}" }),
      ev({ kind: "step-end", text: "hello" }),
      ev({ kind: "end" }),
    ]);
    expect(items.map((i) => i.type)).toEqual(["turn-start", "compaction", "text", "turn-end"]);
  });
});

describe("toolBrief", () => {
  it("prefers command, then path, and flattens whitespace", () => {
    expect(toolBrief('{"command":"cd x &&\n  ls"}')).toBe("cd x && ls");
    expect(toolBrief('{"path":"src/a.ts","content":"zzz"}')).toBe("src/a.ts");
  });
  it("survives clipped JSON and truncates long text", () => {
    expect(toolBrief('{"command":"echo \\"hi\\" && sleep 3')).toBe('echo "hi" && sleep 3');
    expect(toolBrief(JSON.stringify({ command: "x".repeat(200) }), 20)).toHaveLength(20);
    expect(toolBrief(null)).toBe("");
  });
});

describe("summarizeActivity", () => {
  it("counts only the latest turn, ignores synthetic events, and reports the call in flight", () => {
    const a = summarizeActivity([
      ev({ kind: "start" }),
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "old", input: '{"command":"old"}' }),
      ev({ kind: "tool-end", toolName: "bash", toolCallId: "old", output: "" }),
      ev({ kind: "end" }),
      ev({ kind: "start" }),
      ev({ kind: "tool-start", toolName: "read", toolCallId: "r", input: '{"path":"a.ts"}' }),
      ev({ kind: "tool-end", toolName: "read", toolCallId: "r", output: "" }),
      ev({ kind: "tool-start", toolName: "fileChange", toolCallId: "f", input: '{"event":"add","path":"zzz"}' }),
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "b", input: '{"command":"npm test"}' }),
    ]);
    expect(a.toolCalls).toBe(2);
    expect(a.current).toEqual({ toolName: "bash", brief: "npm test" });
    expect(a.last).toEqual({ toolName: "bash", brief: "npm test" });
  });
  it("has no current call between tools", () => {
    const a = summarizeActivity([
      ev({ kind: "start" }),
      ev({ kind: "tool-start", toolName: "read", toolCallId: "r", input: '{"path":"a.ts"}' }),
      ev({ kind: "tool-end", toolName: "read", toolCallId: "r", output: "" }),
    ]);
    expect(a.current).toBeNull();
    expect(a.last).toEqual({ toolName: "read", brief: "a.ts" });
  });
});
