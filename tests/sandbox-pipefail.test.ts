import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { withPipefail } from "../lib/sandboxes/provision";

/** Same invocation shape as execSandbox (`bash -lc <script>`), run locally. */
function status(command: string): number {
  try {
    execFileSync("bash", ["-lc", withPipefail(command)], { stdio: "ignore" });
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
}

describe("withPipefail (0082)", () => {
  it("a failing first stage fails the pipeline", () => {
    expect(status("exit 7 | tail -1")).not.toBe(0);
    expect(status("false | cat")).toBe(1);
  });
  it("success stays success", () => {
    expect(status("echo hi | tail -1")).toBe(0);
  });
  it("the command's own last status is still the exit code", () => {
    expect(status("false; true")).toBe(0);
    expect(status("true; exit 3")).toBe(3);
  });
});
