import { describe, expect, it } from "vitest";
import { sandboxContainerIdentity } from "../lib/sandboxes/identity";

const shell = (result: { exitCode: number; stdout: string }) => ({
  run: async () => ({ stderr: "", ...result }),
});

describe("sandboxContainerIdentity", () => {
  it("returns the trimmed container hostname", async () => {
    expect(
      await sandboxContainerIdentity(shell({ exitCode: 0, stdout: "abc123\n" })),
    ).toBe("abc123");
  });

  it("returns null when the probe fails", async () => {
    expect(
      await sandboxContainerIdentity(shell({ exitCode: 1, stdout: "" })),
    ).toBeNull();
  });

  it("returns null for empty output — never a stable identity", async () => {
    expect(
      await sandboxContainerIdentity(shell({ exitCode: 0, stdout: "  \n" })),
    ).toBeNull();
  });
});
