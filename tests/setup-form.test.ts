import { describe, expect, it } from "vitest";
import {
  definitionFromSetupForm,
  emptySetupForm,
  isLaunchable,
  overridesFromSetupForm,
  setupFormFromDefinition,
} from "../components/project/setup-form";
import { parsePreviewOverrides } from "../lib/previews/overrides";
import { parsePreviewSetup } from "../lib/previews/setup";

/**
 * 0019 phase 5: the setup editor's pure half — form values ⇄ definition,
 * and the first-fill request body. The overrides parser is the server's
 * side of the same contract, so the round trip is asserted through it.
 */

const filled = {
  ...emptySetupForm,
  workDir: "apps/web",
  install: "pnpm install",
  migrate: "pnpm run migrate",
  seed: "pnpm run seed",
  command: "pnpm run dev",
  port: "3000",
  envText: 'A=1\nB="two words"\n# comment\n',
  services: [{ name: "db", image: "postgres:18", port: "5432", command: "", envText: "POSTGRES_PASSWORD=pw" }],
};

describe("0019: setup form conversions", () => {
  it("a definition round-trips through the form", () => {
    const def = parsePreviewSetup({
      repo: "p/web", workDir: "apps/web", install: "pnpm install", migrate: "m", seed: "s",
      command: "pnpm run dev", port: 3000, env: { A: "1", B: "two words" },
      services: [{ name: "db", image: "postgres:18", port: 5432, env: { X: "y" } }],
    });
    if (!def.ok) throw new Error(def.issues.join("; "));
    const back = definitionFromSetupForm(setupFormFromDefinition(def.definition), "p/web");
    expect(back).toEqual({ definition: def.definition });
  });

  it("builds a definition from textarea conventions; blank workDir means the repo root", () => {
    const built = definitionFromSetupForm({ ...filled, workDir: " " }, "p/web");
    if ("error" in built) throw new Error(built.error);
    expect(built.definition).toMatchObject({
      repo: "p/web", workDir: ".", migrate: "pnpm run migrate", env: { A: "1", B: "two words" },
      services: [{ name: "db", image: "postgres:18", port: 5432, env: { POSTGRES_PASSWORD: "pw" } }],
    });
  });

  it("names the problem for a bad env line, a half-filled service, or a bad service port", () => {
    expect(definitionFromSetupForm({ ...filled, envText: "NOEQUALS" }, "r")).toEqual({ error: expect.stringContaining("KEY=VALUE") });
    expect(definitionFromSetupForm({ ...filled, services: [{ ...filled.services[0]!, image: "" }] }, "r")).toEqual({
      error: "service 1: name and image are required",
    });
    expect(definitionFromSetupForm({ ...filled, services: [{ ...filled.services[0]!, port: "99999" }] }, "r")).toEqual({
      error: "service db: port must be 1–65535",
    });
  });
});

describe("0019: first-fill request body", () => {
  it("sends the whole definition plus the label, and the server parser accepts it as-is", () => {
    const body = overridesFromSetupForm(filled, "p/web", "  my label ");
    if ("error" in body) throw new Error(String(body.error));
    expect(body).toMatchObject({ workDir: "apps/web", command: "pnpm run dev", port: 3000, label: "my label", migrate: "pnpm run migrate" });
    const parsed = parsePreviewOverrides(body);
    expect(parsed).toEqual({ overrides: expect.objectContaining({ port: 3000, env: { A: "1", B: "two words" } }) });
  });

  it("omits blank fields so the server falls back to defaults", () => {
    expect(overridesFromSetupForm(emptySetupForm, "p/web", "")).toEqual({});
  });

  it("propagates form errors instead of sending a partial body", () => {
    expect(overridesFromSetupForm({ ...filled, envText: "bad" }, "r", "")).toEqual({ error: expect.any(String) });
  });

  it("isLaunchable needs command, install and port", () => {
    expect(isLaunchable(filled)).toBe(true);
    expect(isLaunchable({ ...filled, install: " " })).toBe(false);
    expect(isLaunchable(emptySetupForm)).toBe(false);
  });
});
