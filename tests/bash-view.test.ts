import { describe, expect, it } from "vitest";
import { luminance, parseAnsi, stripAnsi } from "../lib/ansi";
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
      { text: "red", fg: "red" },
      { text: " plain " },
      { text: "go", fg: "green", bold: true },
    ]);
  });

  it("reads background colours (vitest's RUN badge)", () => {
    const [line] = parseAnsi("\x1b[46m\x1b[30m RUN \x1b[39m\x1b[49m v5");
    expect(line).toEqual([{ text: " RUN ", fg: "black", bg: "cyan" }, { text: " v5" }]);
  });

  it("resolves inverse video, with and without explicit colours", () => {
    expect(parseAnsi("\x1b[7mx\x1b[27my")[0]).toEqual([{ text: "x", fg: "background", bg: "foreground" }, { text: "y" }]);
    expect(parseAnsi("\x1b[31;7mx")[0]).toEqual([{ text: "x", fg: "background", bg: "red" }]);
  });

  it("handles 256-colour: base indices stay theme colours, the cube and ramp become literals", () => {
    expect(parseAnsi("\x1b[38;5;1ma")[0][0].fg).toBe("red");
    expect(parseAnsi("\x1b[38;5;196ma")[0][0].fg).toBe("#ff0000");
    expect(parseAnsi("\x1b[48;5;244ma")[0][0].bg).toBe("#808080");
  });

  it("handles truecolor fg and bg", () => {
    expect(parseAnsi("\x1b[38;2;10;20;30;48;2;255;128;0mx")[0]).toEqual([{ text: "x", fg: "#0a141e", bg: "#ff8000" }]);
  });

  it("reads italic, underline, strikethrough and their resets", () => {
    expect(parseAnsi("\x1b[3;4;9ma\x1b[23;24;29mb")[0]).toEqual([
      { text: "a", italic: true, underline: true, strike: true },
      { text: "b" },
    ]);
  });

  it("keeps only the last carriage-return frame, carries style across it, and drops other escapes", () => {
    const lines = parseAnsi("10%\r\x1b[32m50%\r100%\n\x1b[2Kdone\x1b]0;title\x07");
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["100%", "done"]);
    expect(lines[0][0].fg).toBe("green");
  });

  it("stripAnsi removes everything", () => {
    expect(stripAnsi("\x1b[31ma\x1b[0m\x1b[2K")).toBe("a");
  });

  it("luminance tells light from dark literals", () => {
    expect(luminance("#ffffff")).toBeGreaterThan(0.9);
    expect(luminance("#101010")).toBeLessThan(0.05);
  });
});
