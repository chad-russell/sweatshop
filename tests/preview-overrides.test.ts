import { describe, expect, it } from "vitest";
import { parsePreviewOverrides } from "../lib/previews/overrides";

describe("0019: preview overrides (create + confirm body)", () => {
  it("an empty or blank body is no overrides", () => {
    expect(parsePreviewOverrides({})).toEqual({ overrides: {} });
    expect(parsePreviewOverrides(undefined)).toEqual({ overrides: {} });
    expect(
      parsePreviewOverrides({ command: "  ", install: "", port: "", env: {}, services: [], label: " " }),
    ).toEqual({ overrides: {} });
  });

  it("trims text, coerces a numeric-string port, and keeps set fields", () => {
    expect(
      parsePreviewOverrides({
        workDir: " apps/web ",
        install: "pnpm install",
        command: "pnpm run dev",
        port: "3000",
        label: "pr 12",
        provision: "pnpm migrate",
        seed: "pnpm seed",
        env: { A: "1" },
        services: [{ name: "db", image: "postgres:18", port: 5432 }],
        branch: "ignored", // routes pass the whole body; unknown keys drop
      }),
    ).toEqual({
      overrides: {
        workDir: "apps/web",
        install: "pnpm install",
        command: "pnpm run dev",
        port: 3000,
        label: "pr 12",
        provision: "pnpm migrate",
        seed: "pnpm seed",
        env: { A: "1" },
        services: [{ name: "db", image: "postgres:18", port: 5432, env: {} }],
      },
    });
  });

  it("rejects a bad port, non-string env values, and a malformed service — naming the field", () => {
    expect(parsePreviewOverrides({ port: 70_000 })).toEqual({ error: expect.stringContaining("port") });
    expect(parsePreviewOverrides({ port: "abc" })).toEqual({ error: expect.stringContaining("port") });
    expect(parsePreviewOverrides({ env: { A: 1 } })).toEqual({ error: expect.stringContaining("env") });
    expect(parsePreviewOverrides({ services: [{ name: "DB", image: "x", port: 1 }] })).toEqual({
      error: expect.stringContaining("services"),
    });
  });
});
