import { describe, expect, it } from "vitest";
import { callLabel, callState, groupParts, groupStatus, MIN_GROUP, type PartLike } from "../lib/tool-views/groups";

const done = (type: string, input: unknown, output: unknown = { ok: true }): PartLike => ({
  type: `tool-${type}`, state: "output-available", input, output,
});
const bash = (command: string, exitCode = 0) => done("bash", { command }, { exitCode, stdout: "", stderr: "" });
const inspect = (id: string, status = "busy") => done("inspect", { id }, { kind: "chat", id, status });
const text = (t: string): PartLike => ({ type: "text", text: t });

describe("groupParts", () => {
  it("leaves short runs alone", () => {
    const segs = groupParts([bash("a"), bash("b")]);
    expect(segs.map((s) => s.kind)).toEqual(["part", "part"]);
    expect(MIN_GROUP).toBe(3);
  });

  it("folds a run of quiet calls across tools, summarised in order", () => {
    const segs = groupParts([bash("a"), bash("b"), done("system_docs", { topic: "x" }), bash("c")]);
    expect(segs).toHaveLength(1);
    const g = segs[0]!;
    expect(g.kind === "group" && g.summary).toBe("ran 3 commands · read 1 doc");
  });

  it("merges identical consecutive polls into one ×N entry holding the latest call", () => {
    const parts = [inspect("c_1"), inspect("c_1"), inspect("c_1", "idle"), bash("ls")];
    const g = groupParts(parts)[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g.entries).toHaveLength(2);
    expect(g.entries[0]).toMatchObject({ count: 3, index: 2 });
    expect(g.calls).toBe(4);
    expect(g.summary).toBe("checked chats ×3 · ran 1 command");
  });

  it("does not merge polls of different targets, nor non-poll repeats", () => {
    const g = groupParts([inspect("c_1"), inspect("c_2"), bash("ls"), bash("ls")])[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g.entries.map((e) => e.count)).toEqual([1, 1, 1, 1]);
  });

  it("text and loud tools end a run; blank text and non-tool parts do not", () => {
    const segs = groupParts([bash("a"), { type: "step-start" }, text("  "), bash("b"), bash("c"), text("done"), bash("d"), done("create_pr", {}), bash("e")]);
    expect(segs.map((s) => s.kind)).toEqual(["group", "part", "part", "part", "part"]);
  });

  it("never folds approvals, harness calls, threads or screenshots", () => {
    const loud = ["ask_owner", "create_pr", "pi", "claude", "start_thread", "attach_screenshot", "present_plan", "start_preview", "cancel_run"];
    const segs = groupParts(loud.map((t) => done(t, {})));
    expect(segs.every((s) => s.kind === "part")).toBe(true);
    const gated: PartLike = { type: "tool-bash", state: "approval-requested", input: { command: "x" } };
    expect(groupParts([bash("a"), bash("b"), gated, bash("c")]).map((s) => s.kind)).toEqual(["part", "part", "part", "part"]);
  });

  it("keeps failures and live work visible in the group's counts and focus", () => {
    const running: PartLike = { type: "tool-bash", state: "input-available", input: { command: "sleep 9" } };
    const g = groupParts([bash("a"), bash("boom", 2), running])[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g).toMatchObject({ failed: 1, running: 1 });
    expect(callLabel(g.focus)).toBe("sleep 9");
    const settled = groupParts([bash("a"), bash("boom", 2), bash("c")])[0]!;
    expect(settled.kind === "group" && callLabel(settled.focus)).toBe("boom");
  });
});

describe("callState / callLabel", () => {
  it("reads exit codes and ok:false as failure", () => {
    expect(callState(bash("x", 1))).toBe("failed");
    expect(callState(done("gh", {}, { ok: false }))).toBe("failed");
    expect(callState({ type: "tool-bash", state: "output-error" })).toBe("failed");
    expect(callState(bash("x"))).toBe("ok");
    expect(callState({ type: "tool-bash", state: "input-streaming" })).toBe("running");
  });

  it("labels a call by what it was about", () => {
    expect(callLabel(bash("cd a &&\n  ls"))).toBe("cd a &&");
    expect(callLabel(done("bash", { command: "rg -n x", description: " Find  callers of x " }))).toBe("Find callers of x");
    expect(callLabel(done("sandbox_exec", { target: "c_1", command: "ls", description: "" }))).toBe("ls");
    expect(callLabel(inspect("c_9"))).toBe("c_9 · busy");
    expect(callLabel({ type: "tool-inspect", state: "input-available", input: { id: "c_9" } })).toBe("c_9");
    expect(callLabel(done("gh", { args: ["repo", "view", "x/y"] }))).toBe("gh repo view x/y");
    expect(callLabel(done("web_fetch", { url: "https://a.b" }))).toBe("https://a.b");
    expect(callLabel(done("list_projects", {}))).toBe("List projects");
    expect(callLabel(done("get_preview_setup", {}))).toBe("Read preview setup");
    expect(callLabel(done("preview_status", {}))).toBe("Check previews");
  });
});

describe("groupStatus", () => {
  it("describes completed activity, not overall task success", () => {
    expect(groupStatus({ running: 0, failed: 0 })).toEqual({ tone: "ok", label: "completed" });
    expect(groupStatus({ running: 0, failed: 1 })).toEqual({ tone: "warn", label: "completed · 1 failed call" });
    expect(groupStatus({ running: 0, failed: 2 })).toEqual({ tone: "warn", label: "completed · 2 failed calls" });
  });

  it("keeps live work running even when earlier calls failed", () => {
    expect(groupStatus({ running: 2, failed: 0 })).toEqual({ tone: "running", label: "running" });
    expect(groupStatus({ running: 1, failed: 2 })).toEqual({ tone: "running", label: "running · 2 failed calls" });
  });

  it("does not claim that a successful later call recovered the earlier failure", () => {
    const group = groupParts([bash("failed", 1), bash("next"), bash("last")])[0]!;
    if (group.kind !== "group") throw new Error("expected group");
    expect(groupStatus(group)).toEqual({ tone: "warn", label: "completed · 1 failed call" });
  });
});

describe("harness read tools in a group", () => {
  const read = (path: string) => done("read", { file_path: path }, "file contents");
  const ls = (path = ".") => done("ls", { path }, "a.ts\nb.ts\n");
  const grep = (pattern: string) => done("grep", { pattern }, "a.ts:1:match\n");

  it("groups read/grep/glob/find/ls at ≥3 quiet calls, labelled by path/pattern", () => {
    const segs = groupParts([read("a.ts"), read("b.ts"), ls()]);
    expect(segs).toHaveLength(1);
    const g = segs[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g.summary).toBe("read 2 files · searched files");
    expect(callLabel(read("a.ts"))).toBe("a.ts");
    expect(callLabel(ls("src"))).toBe("src");
    expect(callLabel(ls())).toBe(".");
    expect(callLabel(grep("TODO"))).toBe("TODO");
  });

  it("folds grep/glob/find/ls into ONE 'searched files' phrase with their combined count", () => {
    const g = groupParts([grep("TODO"), ls(), read("a.ts"), read("b.ts")])[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    const occurrences = g.summary.split("searched files").length - 1;
    expect(occurrences).toBe(1);
    expect(g.summary).toContain("searched files ×2");
    expect(g.summary).toContain("read 2 files");
  });

  it("a plain-text (non-object) output from a harness read tool counts as ok", () => {
    expect(callState(read("a.ts"))).toBe("ok");
    expect(callState(ls())).toBe("ok");
    expect(callState(grep("TODO"))).toBe("ok");
  });

  it("an error state still marks a harness read tool as failed", () => {
    expect(callState({ type: "tool-read", state: "output-error", input: { file_path: "a.ts" } })).toBe("failed");
  });

  it("a read whose file content happens to parse as a result envelope still counts as ok", () => {
    const jsonFixture = done("read", { file_path: "error.json" }, '{"ok":false,"code":"boom"}');
    const g = groupParts([read("a.ts"), jsonFixture, read("c.ts")])[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g.failed).toBe(0);
    expect(callState(jsonFixture)).toBe("ok");
    expect(callState(done("read", { file_path: "k.json" }, '{"kind":"error","message":"x"}'))).toBe("ok");
  });

  it("write/edit stay loud (never fold even at ≥3)", () => {
    const write = done("write", { path: "a.ts", content: "x" }, "ok");
    const edit = done("edit", { path: "a.ts" }, "ok");
    const segs = groupParts([write, edit, write]);
    expect(segs.every((s) => s.kind === "part")).toBe(true);
  });

  it("a text part between read calls splits the run (a boundary, not a fold)", () => {
    const segs = groupParts([read("a.ts"), read("b.ts"), text("found it"), read("c.ts"), read("d.ts"), read("e.ts")]);
    expect(segs.map((s) => s.kind)).toEqual(["part", "part", "part", "group"]);
  });

  it("unwraps codex's bash -lc wrapper in the call label", () => {
    const wrapped = done("bash", { command: '/bin/bash -lc "npm test"' }, { exitCode: 0, stdout: "", stderr: "" });
    expect(callLabel(wrapped)).toBe("npm test");
  });
});

describe("inspect in a group", () => {
  const chat = (busy: boolean) =>
    done("inspect", { id: "c_1" }, { kind: "chat", id: "c_1", title: null, busy, tail: [{ role: "user", text: "Review the diff", at: 1 }] });

  it("labels by what the chat is and where it stands, and a folded poll shows the latest state", () => {
    expect(callLabel(chat(true))).toBe("Review the diff · working");
    const g = groupParts([chat(true), chat(true), chat(false)])[0]!;
    if (g.kind !== "group") throw new Error("expected group");
    expect(g.entries).toHaveLength(1);
    expect(callLabel(g.entries[0]!.part)).toBe("Review the diff · idle");
  });

  it("an inspect that returned kind:'error' counts as failed", () => {
    expect(callState(done("inspect", { id: "x" }, { kind: "error", code: "unknown-id", message: "no" }))).toBe("failed");
  });
});
