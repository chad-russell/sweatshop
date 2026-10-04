import { describe, expect, it } from "vitest";
import { envFileContent, maskEnv, parseEnvBlock, resolvePreviewEnv } from "../lib/previews/env";

/**
 * 0017 phase 2: env resolution — layering, platform interpolation,
 * value-shaped errors, the pasted-block parser, masking.
 */

const platform = {
  PORT: "3000",
  HOST: "0.0.0.0",
  PREVIEW_HOST: "pv-x.internal.crussell.io",
  PREVIEW_URL: "https://pv-x.internal.crussell.io",
};

describe("0017 env resolution", () => {
  it("layers setup env under overrides (later wins)", () => {
    const r = resolvePreviewEnv(
      { A: "setup", B: "setup", C: "setup" },
      { B: "override", D: "override" },
      platform,
    );
    expect(r).toEqual({ env: { A: "setup", B: "override", C: "setup", D: "override" } });
  });

  it("interpolates platform references inside values", () => {
    const r = resolvePreviewEnv(
      { SITE: "${PREVIEW_URL}/api", HOSTBIND: "${HOST}:${PORT}", PLAIN: "no refs ${}" },
      null,
      platform,
    );
    expect(r).toEqual({
      env: {
        SITE: "https://pv-x.internal.crussell.io/api",
        HOSTBIND: "0.0.0.0:3000",
        PLAIN: "no refs ${}",
      },
    });
  });

  it("service references are a clear error until phase 3, not an empty address", () => {
    const r = resolvePreviewEnv({ DATABASE_URL: "postgres@${service:db:5432}" }, null, platform);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("service");
  });

  it("unknown references name the key", () => {
    const r = resolvePreviewEnv({ X: "${NOPE}" }, null, platform);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("X");
  });
});

describe("0017 env block parser", () => {
  it("parses KEY=VALUE lines, dropping blanks and comments", () => {
    expect(parseEnvBlock("A=1\n\n# note\nB=two words\nC=\"quoted = value\"\nD='single'\n")).toEqual({
      env: { A: "1", B: "two words", C: "quoted = value", D: "single" },
    });
  });

  it("rejects a line without a separator, naming it", () => {
    expect(parseEnvBlock("A=1\nbroken line\n")).toMatchObject({
      error: expect.stringContaining("broken line"),
    });
  });
});

describe("0017 env display + file", () => {
  it("masks values, keeps keys", () => {
    expect(maskEnv({ SECRET: "hunter2", PUBLIC: "x" })).toEqual({ SECRET: "••••••••", PUBLIC: "••••••••" });
  });

  it("writes a shell-sourceable file with quoted values", () => {
    const content = envFileContent({ A: "plain", B: "two words'quote" });
    expect(content).toBe("A='plain'\nB='two words'\\''quote'\n");
  });
});
