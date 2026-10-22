import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessEventLog, type HarnessEvent } from "../components/harness-session-view";

/**
 * 0063: the harness session log reuses the chat's own quiet-calls
 * grouping (`groupParts`/`ToolGroupView`, via `timelineToParts`) — a run
 * of ≥3 quiet read-only calls folds into one collapsed group with a
 * shared summary and status pill, across every harness's own tool
 * naming (pi lowercase, claude capitalised, codex's wrapped bash).
 */

let n = 0;
const ev = (e: Omit<HarnessEvent, "id" | "at">): HarnessEvent => ({ id: ++n, at: ++n, ...e });

function readRun(toolName: string, pathKey: string) {
  return [
    ev({ kind: "tool-start", toolName, toolCallId: "r1", input: JSON.stringify({ [pathKey]: "a.ts" }) }),
    ev({ kind: "tool-end", toolName, toolCallId: "r1", output: "contents a" }),
    ev({ kind: "tool-start", toolName, toolCallId: "r2", input: JSON.stringify({ [pathKey]: "b.ts" }) }),
    ev({ kind: "tool-end", toolName, toolCallId: "r2", output: "contents b" }),
    ev({ kind: "tool-start", toolName, toolCallId: "r3", input: JSON.stringify({ [pathKey]: "c.ts" }) }),
    ev({ kind: "tool-end", toolName, toolCallId: "r3", output: "contents c" }),
  ];
}

function render(events: HarnessEvent[]) {
  return renderToStaticMarkup(h(HarnessEventLog, { events }));
}

describe("HarnessEventLog grouping", () => {
  it("folds ≥3 quiet pi read calls into one collapsed group", () => {
    const html = render(readRun("read", "path"));
    expect(html).toContain("read 3 files");
    expect(html).toContain("completed");
    expect(html).toContain('aria-expanded="false"');
  });

  it("folds claude's capitalised Read the same way", () => {
    const html = render(readRun("Read", "file_path"));
    expect(html).toContain("read 3 files");
  });

  it("folds codex-wrapped bash commands, unwrapped in the focus label", () => {
    const events = [
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "b1", input: JSON.stringify({ command: '/bin/bash -lc "echo one"' }) }),
      ev({ kind: "tool-end", toolName: "bash", toolCallId: "b1", output: "one\n(exit 0)" }),
      ev({ kind: "tool-start", toolName: "bash", toolCallId: "b2", input: JSON.stringify({ command: '/bin/bash -lc "echo two"' }) }),
      ev({ kind: "tool-end", toolName: "bash", toolCallId: "b2", output: "two\n(exit 0)" }),
      ev({
        kind: "tool-start",
        toolName: "bash",
        toolCallId: "b3",
        input: JSON.stringify({ command: '/bin/bash -lc "echo three"' }),
      }),
    ];
    const html = render(events);
    expect(html).toContain("ran 3 commands");
    // Still running: the focus label shows the live call, unwrapped.
    expect(html).toContain("echo three");
    expect(html).not.toContain("/bin/bash -lc");
  });

  it("a write call stays its own card, never folded even alongside quiet reads", () => {
    const events = [
      ...readRun("read", "path"),
      ev({ kind: "tool-start", toolName: "write", toolCallId: "w1", input: JSON.stringify({ path: "d.ts", content: "x" }) }),
      ev({ kind: "tool-end", toolName: "write", toolCallId: "w1", output: "ok" }),
    ];
    const html = render(events);
    expect(html).toContain("read 3 files");
    // The write call renders its own FileCard header, outside the group.
    expect(html).toContain("d.ts");
  });
});
