import { describe, expect, it } from "vitest";
import { failureOf, inspectName, inspectOf, inspectState, oneLine } from "../lib/machine-tool-view";
import {
  cancelView,
  docsView,
  forgejoView,
  ghView,
  h1Of,
  maskEnvValue,
  noteView,
  prettyJson,
  projectsView,
  runKind,
  setupLabel,
  setupView,
  skillItems,
  skillView,
} from "../lib/info-tool-view";

/** The information tools' card normalisers — pure and defensive, like web-tool-view. */

describe("skillView", () => {
  it("reads a bound skill, taking the title from its H1", () => {
    expect(skillView({ ok: true, id: "ship", note: "Bound.", skill: "# Ship\n\nsteps" })).toEqual({
      kind: "bound", id: "ship", title: "Ship", note: "Bound.", body: "# Ship\n\nsteps",
    });
  });

  it("reads the listing and ignores malformed rows", () => {
    const v = skillView({ ok: true, skills: [{ id: "ship", title: "Ship", description: "d" }, { title: "no id" }, 3] });
    expect(v).toEqual({ kind: "list", skills: [{ id: "ship", title: "Ship", description: "d" }] });
  });

  it("is undefined for failures and junk", () => {
    expect(skillView({ ok: false })).toBeUndefined();
    expect(skillView("clipped")).toBeUndefined();
    expect(skillItems(undefined)).toEqual([]);
  });
});

describe("docsView", () => {
  it("reads a doc and a topic list", () => {
    expect(docsView({ ok: true, topic: "previews", doc: "# Previews\nbody" })).toEqual({
      kind: "doc", topic: "previews", title: "Previews", doc: "# Previews\nbody",
    });
    expect(docsView({ ok: true, topics: [{ topic: "a", title: "A" }, {}] })).toEqual({
      kind: "list", topics: [{ topic: "a", title: "A" }],
    });
    expect(docsView({ ok: false, code: "x", message: "y" })).toBeUndefined();
  });

  it("falls back to the topic when a doc has no H1", () => {
    expect(h1Of("no heading")).toBeUndefined();
    expect(docsView({ ok: true, topic: "t", doc: "text" })).toMatchObject({ title: "t" });
  });
});

describe("projectsView", () => {
  it("reads projects with repos and work defaults", () => {
    const rows = projectsView({
      ok: true,
      projects: [{ id: "gpl", name: "GPL", description: null, repos: [{ name: "360-gpl", url: "u" }, {}], testCommand: "npm test", branchPrefix: null }],
    });
    expect(rows).toEqual([
      { id: "gpl", name: "GPL", description: undefined, repos: [{ name: "360-gpl", url: "u" }], testCommand: "npm test", branchPrefix: undefined },
    ]);
  });

  it("is undefined without a projects array", () => {
    expect(projectsView({ ok: true })).toBeUndefined();
    expect(projectsView(undefined)).toBeUndefined();
  });
});

describe("setupView", () => {
  it("distinguishes no-setup (null) from unreadable (undefined)", () => {
    expect(setupView({ ok: true, setup: null })).toBeNull();
    expect(setupView({ ok: false })).toBeUndefined();
    expect(setupView({ ok: true, setup: { nope: 1 } })).toBeUndefined();
  });

  it("reads the definition", () => {
    const v = setupView({
      ok: true,
      setup: {
        repo: "r", workDir: "apps/web", install: "npm ci", command: "npm run dev", port: 3000,
        env: { A: "1" }, services: [{ name: "db", image: "postgres", port: 5432 }],
      },
    });
    expect(v).toMatchObject({ workDir: "apps/web", port: 3000, env: [["A", "1"]], services: [{ name: "db", image: "postgres", port: 5432 }] });
  });

  it("masks secret-looking env values but not interpolations", () => {
    expect(maskEnvValue("API_TOKEN", "abc")).toBe("••••••");
    expect(maskEnvValue("DB_PASSWORD", "x")).toBe("••••••");
    expect(maskEnvValue("DATABASE_URL", "${service:db:5432}")).toBe("${service:db:5432}");
    expect(maskEnvValue("SECRET_KEY", "${PREVIEW_URL}")).toBe("${PREVIEW_URL}");
    expect(maskEnvValue("NODE_ENV", "development")).toBe("development");
  });
});

describe("ghView / forgejoView", () => {
  it("prints the gh command from the result, else rebuilds it from args with quoting", () => {
    expect(ghView({ args: ["repo", "view"] }, { ok: true, command: "gh repo view", output: "x" })).toEqual({ command: "gh repo view", output: "x" });
    expect(ghView({ args: ["search", "repos", "org:Tango Group"] }, undefined).command).toBe("gh search repos 'org:Tango Group'");
    expect(ghView(undefined, undefined)).toEqual({ command: "gh", output: "" });
  });

  it("prints forgejo as a GET with encoded params and pretty-prints JSON", () => {
    const v = forgejoView({ path: "/repos/search", params: { q: "a b", limit: "10", empty: "" } }, { ok: true, output: '{"a":1}' });
    expect(v.command).toBe("forgejo GET /repos/search?q=a%20b&limit=10");
    expect(v.output).toBe('{\n  "a": 1\n}');
  });

  it("leaves non-JSON and malformed JSON alone", () => {
    expect(prettyJson("plain")).toBe("plain");
    expect(prettyJson("{broken")).toBe("{broken");
  });
});

describe("noteView", () => {
  it("reads the input, falls back to the result minus its echo", () => {
    expect(noteView({ note: "hi" }, "noted: hi")).toBe("hi");
    expect(noteView(undefined, "noted: from output")).toBe("from output");
    expect(noteView(undefined, undefined)).toBe("");
  });
});

describe("setupLabel", () => {
  it("names the repo and port, hiding a root workDir", () => {
    expect(setupLabel({ repo: "gpl/360-gpl", workDir: ".", port: 3006 })).toBe("360-gpl · port 3006");
  });
  it("appends a subdirectory", () => {
    expect(setupLabel({ repo: "polymer/360-polymer", workDir: "apps/polymer", port: 3000 })).toBe("360-polymer/apps/polymer · port 3000");
    expect(setupLabel({ repo: "a/b", workDir: "./web", port: 1 })).toBe("b/web · port 1");
  });
  it("omits what is missing", () => {
    expect(setupLabel({ repo: "", workDir: ".", port: 0 })).toBe("");
  });
});

describe("cancelView / runKind", () => {
  it("prefers the result's id, falls back to the input", () => {
    expect(cancelView({ runId: "hc_1" }, { ok: true, runId: "hc_1", note: "n" })).toEqual({ id: "hc_1", note: "n" });
    expect(cancelView({ runId: "c_2" }, undefined)).toEqual({ id: "c_2", note: undefined });
    expect(cancelView(undefined, undefined).id).toBe("…");
  });

  it("names the kind of run", () => {
    expect(runKind("hc_x")).toBe("harness call");
    expect(runKind("c_x")).toBe("child thread");
    expect(runKind("mr_x")).toBe("run");
  });
});

describe("inspect naming", () => {
  const chat = (over: Record<string, unknown> = {}) => ({
    kind: "chat", id: "c_tmv86hy7f1d689965eec6", title: null, busy: true, totalMessages: 3,
    tail: [
      { role: "user", text: "Fresh-eyes review of WYC-1591 in repo 360-gpl.\nmore", at: 1 },
      { role: "assistant", text: "Reading the diff now", at: 2 },
    ],
    ...over,
  });

  it("names an untitled chat by what it was started to do, never the bare word 'chat'", () => {
    const v = inspectOf(chat())!;
    expect(inspectName(v)).toBe("Fresh-eyes review of WYC-1591 in repo 360-gpl.");
    expect(inspectState(v)).toBe("working");
    expect(v.last).toEqual({ role: "assistant", text: "Reading the diff now" });
  });

  it("prefers a title, falls back to the id, and clips long openers", () => {
    expect(inspectName(inspectOf(chat({ title: "Column move review" }))!)).toBe("Column move review");
    expect(inspectName(inspectOf(chat({ tail: [] }))!)).toBe("c_tmv86hy7f1d689965eec6");
    expect(oneLine("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
    expect(inspectState(inspectOf(chat({ busy: false }))!)).toBe("idle");
  });

  it("names runs and harness calls", () => {
    expect(inspectName(inspectOf({ kind: "run", id: "mr_1", machine: "ship", status: "running" })!)).toBe("ship");
    const call = inspectOf({ kind: "harness-call", id: "hc_1", harness: "pi", status: "running", task: "fix the thing\nplease" })!;
    expect(inspectName(call)).toBe("pi call: fix the thing");
    expect(inspectState(call)).toBe("running");
  });

  it("treats inspect's {kind:'error'} as a failure", () => {
    const err = { kind: "error", code: "unknown-id", message: "nothing to inspect" };
    expect(failureOf(err)).toEqual({ code: "unknown-id", message: "nothing to inspect", issues: [] });
    expect(failureOf(chat())).toBeUndefined();
  });
});
