import { describe, expect, it } from "vitest";
import { parseAnsi, stripAnsi } from "../lib/ansi";
import { parseBash } from "../lib/bash-view";

describe("parseBash", () => {
  it("reads the chat tool's {exitCode, stdout, stderr}", () => {
    expect(parseBash({ command: "ls" }, { exitCode: 2, stdout: "a", stderr: "b" })).toEqual({
      command: "ls", stdout: "a", stderr: "b", exitCode: 2, hasOutput: true,
    });
  });

  it("reads harness text output and its (exit N) suffix", () => {
    const v = parseBash('{"command":"ls /work"}', "c_e2e\n\n\n(exit 0)");
    expect(v).toMatchObject({ command: "ls /work", stdout: "c_e2e", exitCode: 0 });
  });

  it("recovers the command from clipped JSON and unescapes it", () => {
    const v = parseBash('{"command":"echo \\"hi\\"\\nls","timeout":3', undefined);
    expect(v.command).toBe('echo "hi"\nls');
    expect(v.hasOutput).toBe(false);
  });

  it("treats an error text as stderr", () => {
    expect(parseBash({ command: "x" }, undefined, "boom")).toMatchObject({ stderr: "boom", hasOutput: true });
  });
});

describe("parseAnsi", () => {
  it("maps SGR colours and resets", () => {
    const [line] = parseAnsi("\x1b[31mred\x1b[0m plain \x1b[1;32mgo\x1b[m");
    expect(line).toEqual([
      { text: "red", color: "red" },
      { text: " plain " },
      { text: "go", color: "green", bold: true },
    ]);
  });

  it("keeps only the last carriage-return frame and drops other escapes", () => {
    const lines = parseAnsi("10%\r50%\r100%\n\x1b[2Kdone\x1b]0;title\x07");
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["100%", "done"]);
  });

  it("skips 256-colour operands", () => {
    expect(parseAnsi("\x1b[38;5;196mx")[0]).toEqual([{ text: "x" }]);
  });

  it("stripAnsi removes everything", () => {
    expect(stripAnsi("\x1b[31ma\x1b[0m\x1b[2K")).toBe("a");
  });
});
