import { describe, expect, it } from "vitest";
import { callLabel, callState, groupParts, MIN_GROUP, type PartLike } from "../lib/tool-groups";

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
    const loud = ["ask_chad", "create_pr", "pi", "claude", "start_thread", "attach_screenshot", "present_plan", "start_preview", "cancel_run"];
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
    expect(callLabel(done("list_projects", {}))).toBe("list_projects");
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
