import { describe, expect, it } from "vitest";
import { diffStrings, languageFor, parseFileTool } from "../lib/file-tool-view";
import { parseListTool } from "../lib/list-tool-view";
import { field } from "../lib/tool-fields";

describe("field", () => {
  it("reads from an object and from JSON text", () => {
    expect(field({ a: "x" }, "a")).toEqual({ value: "x", clipped: false });
    expect(field('{"a":"x\\ny"}', "a")).toEqual({ value: "x\ny", clipped: false });
    expect(field('{"a":"x"}', "zz")).toBeUndefined();
  });
  it("recovers and flags a value clipped mid-string, even mid-escape", () => {
    expect(field('{"content":"line1\\nline2\\nlin…', "content")).toEqual({ value: "line1\nline2\nlin", clipped: true });
    expect(field('{"content":"ends in slash\\', "content")).toEqual({ value: "ends in slash", clipped: true });
  });
  it("takes the first matching key", () => {
    expect(field('{"path":"a","file_path":"b"', "file_path", "path")?.value).toBe("b");
  });
});

describe("languageFor", () => {
  it("maps extensions and docker files, defaulting to text", () => {
    expect(languageFor("src/a.tsx")).toBe("tsx");
    expect(languageFor("Containerfile.dev")).toBe("docker");
    expect(languageFor("README")).toBe("text");
    expect(languageFor(".env")).toBe("text");
    expect(languageFor("x.weird")).toBe("text");
  });
});

describe("diffStrings", () => {
  it("shows only the change plus context, collapsing the rest", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h"].join("\n");
    const diff = diffStrings(before, after, 1);
    expect(diff.map((d) => `${d.kind}:${d.text}`)).toEqual(["gap:", "ctx:d", "del:e", "add:E", "ctx:f", "gap:"]);
  });
  it("handles pure additions and deletions", () => {
    expect(diffStrings("", "x\ny").map((d) => d.kind)).toEqual(["add", "add"]);
    expect(diffStrings("x\ny", "").map((d) => d.kind)).toEqual(["del", "del"]);
  });
  it("interleaves a multi-line change by LCS", () => {
    const diff = diffStrings("a\nb\nc", "a\nB\nc\nd", 5);
    expect(diff.map((d) => `${d.kind}:${d.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "add:d"]);
  });
});

describe("parseFileTool", () => {
  it("write: numbered lines, created from claude's output type", () => {
    const v = parseFileTool(
      "write",
      '{"file_path":"scratch/MACHINES.md","content":"Opened by a run.\\n"}',
      '{"type":"create","filePath":"scratch/MACHINES.md","structuredPatch":[]}',
    );
    expect(v).toMatchObject({ path: "scratch/MACHINES.md", dir: "scratch/", base: "MACHINES.md", language: "markdown", change: "create", added: 1 });
    expect(v.code).toEqual([{ text: "Opened by a run.", num: 1 }]);
  });
  it("write: pi's plain output carries no change — the fileChange hint fills it in", () => {
    expect(parseFileTool("write", { file_path: "a.ts", content: "x" }, "Wrote a.ts").change).toBeUndefined();
    expect(parseFileTool("write", { file_path: "a.ts", content: "x" }, "Wrote a.ts", "update").change).toBe("update");
  });
  it("write: an overwrite with a structuredPatch renders as a diff", () => {
    const v = parseFileTool(
      "write",
      { file_path: "a.ts", content: "new" },
      JSON.stringify({ type: "update", filePath: "a.ts", structuredPatch: [{ oldStart: 3, newStart: 3, lines: [" keep", "-old", "+new"] }] }),
    );
    expect(v.diff).toEqual([
      { kind: "ctx", text: "keep", num: 3 },
      { kind: "del", text: "old", num: 4 },
      { kind: "add", text: "new", num: 4 },
    ]);
    expect([v.added, v.removed]).toEqual([1, 1]);
  });
  it("write: flags clipped content", () => {
    expect(parseFileTool("write", '{"file_path":"a.ts","content":"abc…', "Wrote a.ts").clipped).toBe(true);
  });
  it("edit: diffs old/new strings and counts the change", () => {
    const v = parseFileTool("edit", { file_path: "src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, "ok");
    expect(v.diff?.map((d) => d.kind)).toEqual(["del", "add"]);
    expect([v.added, v.removed]).toEqual([1, 1]);
  });
  it("edit: prefers claude's structuredPatch (with real line numbers)", () => {
    const v = parseFileTool(
      "edit",
      { file_path: "a.ts", old_string: "x", new_string: "y" },
      JSON.stringify({ structuredPatch: [{ oldStart: 10, newStart: 10, lines: ["-x", "+y"] }, { oldStart: 40, newStart: 40, lines: ["-p", "+q"] }] }),
    );
    expect(v.diff?.map((d) => `${d.kind}${d.num ?? ""}`)).toEqual(["del10", "add10", "gap", "del40", "add40"]);
  });
  it("read: numbers plain output from offset and understands cat -n output", () => {
    expect(parseFileTool("read", { file_path: "a.ts", offset: 5 }, "x\ny").code).toEqual([
      { text: "x", num: 5 },
      { text: "y", num: 6 },
    ]);
    expect(parseFileTool("read", { file_path: "a.ts" }, "     7→foo\n     8→bar").code).toEqual([
      { text: "foo", num: 7 },
      { text: "bar", num: 8 },
    ]);
  });
  it("read: a JSON file's text is shown as text, not parsed away", () => {
    const v = parseFileTool("read", { file_path: "package.json" }, '{"name":"x"}');
    expect(v.code).toEqual([{ text: '{"name":"x"}', num: 1 }]);
    expect(v.language).toBe("json");
  });
});

describe("parseListTool", () => {
  it("ls: directories vs files, and harness notices", () => {
    const v = parseListTool("ls", { path: "." }, "is-odd/\nscratch/\nREADME.md\n[100 entries limit reached]");
    expect(v.entries.map((e) => `${e.kind}:${e.path}`)).toEqual(["dir:is-odd/", "dir:scratch/", "file:README.md"]);
    expect(v.notes).toEqual(["100 entries limit reached"]);
    expect(v.arg).toBe(".");
  });
  it("grep: path:line:text matches, with the pattern as its argument", () => {
    const v = parseListTool("grep", { pattern: "TODO", path: "src" }, "src/a.ts:12:  // TODO fix\nsrc/b.ts:3-context line");
    expect(v.arg).toBe("TODO in src");
    expect(v.entries[0]).toEqual({ kind: "match", path: "src/a.ts", line: 12, text: "// TODO fix" });
    expect(v.entries).toHaveLength(2);
  });
  it("is empty (not broken) before any output", () => {
    expect(parseListTool("glob", { pattern: "**/*.ts" }, undefined).entries).toEqual([]);
  });
});
