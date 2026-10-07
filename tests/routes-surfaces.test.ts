import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { getConversation } from "../db/chat";
import { createMachine, createRun, getRun } from "../db/machines";
import { getGlobalDefaults, getProjectModels, setProjectModels } from "../db/providers";
import { conversations, projects, settings } from "../db/schema";
import { parseDefinition, type MachineDefinition } from "../lib/machines/definition";
import { applyOps, EditError, setStageRoute, updateStage } from "../lib/machines/edit";
import { setDefaultRoute, setProjectModelSettings } from "../lib/providers/settings";
import { titleRouteFor } from "../lib/titles";
import { PATCH as patchProjectModels } from "../app/api/projects/[projectId]/models/route";
import { PUT as putSettings } from "../app/api/settings/route";

/**
 * 0021 phases 2–5 at their seams: the settings and project-models write
 * paths, stage routes through the edit ops, run overrides, and the
 * title call's route under a project restriction.
 */

const KEYS = ["ZAI_API_KEY", "GLOO_API_KEY", "OPENROUTER_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.ZAI_API_KEY = "k";
  process.env.GLOO_API_KEY = "k";
  delete process.env.OPENROUTER_API_KEY;
  db().delete(settings).run();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function project(id: string) {
  db().insert(projects).values({ id, name: id, createdAt: Date.now() }).onConflictDoNothing().run();
}

const json = (body: unknown, method = "PUT") => new Request("http://x", { method, body: JSON.stringify(body) });

describe("global defaults write path", () => {
  it("saves a valid default and resets with null", async () => {
    const res = await putSettings(json({ surface: "chat", route: { provider: "gloo", model: "gloo-kimi-k3" } }));
    expect(res.status).toBe(200);
    expect(getGlobalDefaults(db()).chat).toEqual({ provider: "gloo", model: "gloo-kimi-k3" });
    expect(setDefaultRoute(db(), "chat", null)).toEqual({ ok: true });
    expect(getGlobalDefaults(db()).chat).toMatchObject({ provider: "glm" });
  });

  it("rejects an unknown surface, a wrong shape, a missing key, and an unknown model", async () => {
    expect(setDefaultRoute(db(), "nope", null).ok).toBe(false);
    // pi surface needs a pi-shaped route
    expect(setDefaultRoute(db(), "pi", { provider: "glm", model: "glm-5.3" }).ok).toBe(false);
    expect(setDefaultRoute(db(), "pi", { harness: "pi", provider: "glm", model: "glm-5.3", thinking: "high" }).ok).toBe(true);
    // no OpenRouter key in this test
    const noKey = await putSettings(json({ surface: "chat", route: { provider: "openrouter", model: "a/b" } }));
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).issues[0]).toContain("not configured");
    expect(setDefaultRoute(db(), "titles", { provider: "glm", model: "glm-9" })).toEqual({
      ok: false,
      issues: [expect.stringContaining("not in GLM")],
    });
  });

  it("claude defaults take model/effort, never a provider", () => {
    expect(setDefaultRoute(db(), "claude", { harness: "claude", model: "opus", effort: "high" }).ok).toBe(true);
    expect(setDefaultRoute(db(), "claude", { harness: "claude", provider: "gloo" }).ok).toBe(false);
  });
});

describe("project model settings", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ projectId: id }) });

  it("sets a default and restrictions; the default must stay allowed", async () => {
    project("pms");
    const ok = await patchProjectModels(
      json({ defaultRoute: { provider: "gloo", model: "gloo-kimi-k3" }, allowedProviders: ["gloo"] }, "PATCH"),
      ctx("pms"),
    );
    expect(ok.status).toBe(200);
    expect(getProjectModels(db(), "pms")).toMatchObject({ allowedProviders: ["gloo"], defaultRoute: { provider: "gloo" } });

    // Narrowing providers so the default is no longer allowed is refused.
    const narrowed = setProjectModelSettings(db(), "pms", { allowedProviders: ["glm"] });
    expect(narrowed.ok).toBe(false);
    // A default on a forbidden provider is refused.
    expect(setProjectModelSettings(db(), "pms", { defaultRoute: { provider: "glm", model: "glm-5.3" } }).ok).toBe(false);
    // Clearing restrictions = everything allowed.
    expect(setProjectModelSettings(db(), "pms", { allowedProviders: null }).ok).toBe(true);
    expect(getProjectModels(db(), "pms")?.allowedProviders).toBeNull();
  });

  it("validates list entries and 404s an unknown project", async () => {
    project("pms2");
    expect(setProjectModelSettings(db(), "pms2", { allowedHarnesses: ["cursor"] }).ok).toBe(false);
    expect(setProjectModelSettings(db(), "pms2", { allowedHarnesses: ["pi"] }).ok).toBe(true);
    expect((await patchProjectModels(json({ allowedProviders: null }, "PATCH"), ctx("ghost"))).status).toBe(404);
  });
});

describe("stage routes (edit ops)", () => {
  const def: MachineDefinition = {
    workspace: "project",
    start: "plan",
    stages: {
      plan: { kind: "harness", harness: "pi", title: "Plan", instructions: "", next: [{ to: "think" }] },
      think: { kind: "agent", title: "Think", instructions: "", next: [{ to: "gate" }] },
      gate: { kind: "human", title: "Gate", instructions: "", next: [] },
    },
  };

  it("pins per kind, rejects mismatches, clears with null", () => {
    const pi = setStageRoute(def, "plan", { harness: "pi", provider: "gloo", model: "gloo-kimi-k3", thinking: "high" });
    expect(pi.stages.plan).toMatchObject({ route: { harness: "pi", provider: "gloo" } });
    expect(parseDefinition(pi).ok).toBe(true);
    expect(() => setStageRoute(def, "plan", { harness: "claude", model: "opus" })).toThrow(EditError);
    expect(() => setStageRoute(def, "plan", { provider: "glm", model: "glm-5.3" })).toThrow(EditError);
    expect(() => setStageRoute(def, "think", { harness: "pi", provider: "glm", model: "glm-5.3" })).toThrow(EditError);
    expect(() => setStageRoute(def, "gate", { provider: "glm", model: "glm-5.3" })).toThrow(EditError);
    expect(setStageRoute(pi, "plan", null).stages.plan).not.toHaveProperty("route");
  });

  it("the set_route op applies through applyOps (the agent surface)", () => {
    const next = applyOps(def, [
      { op: "set_route", stage: "think", route: { provider: "gloo", model: "gloo-openai-gpt-6-sol" } },
    ]);
    expect(next.stages.think).toMatchObject({ route: { provider: "gloo", model: "gloo-openai-gpt-6-sol" } });
  });

  it("switching a stage's harness drops a route of the other harness", () => {
    const pi = setStageRoute(def, "plan", { harness: "pi", provider: "glm", model: "glm-5.3" });
    expect(updateStage(pi, "plan", { harness: "claude" }).stages.plan).not.toHaveProperty("route");
  });

  it("the definition schema rejects a route whose harness mismatches the stage", () => {
    const bad = structuredClone(def) as unknown as { stages: { plan: Record<string, unknown> } };
    bad.stages.plan.route = { harness: "claude" };
    expect(parseDefinition(bad).ok).toBe(false);
  });
});

describe("run overrides", () => {
  it("stores valid overrides on the run; rejects unknown stages and bad shapes", () => {
    project("ro");
    createMachine(db(), {
      id: "ro-m",
      name: "ro",
      definition: {
        workspace: "none",
        start: "a",
        stages: { a: { kind: "agent", title: "A", instructions: "", next: [] } },
      },
    });
    const run = createRun(db(), {
      machineId: "ro-m",
      prompt: "go",
      overrides: { route: { provider: "gloo", model: "gloo-kimi-k3" }, stages: { a: { provider: "glm", model: "glm-5.3" } } },
    });
    expect(getRun(db(), run.id).overrides).toEqual({
      route: { provider: "gloo", model: "gloo-kimi-k3" },
      stages: { a: { provider: "glm", model: "glm-5.3" } },
    });
    expect(() => createRun(db(), { machineId: "ro-m", prompt: "go", overrides: { stages: { ghost: { provider: "glm", model: "x" } } } })).toThrow(/no such stage/);
    expect(() => createRun(db(), { machineId: "ro-m", prompt: "go", overrides: { route: { provider: "nope" } } })).toThrow(/overrides/);
    expect(getRun(db(), createRun(db(), { machineId: "ro-m", prompt: "go" }).id).overrides).toBeNull();
  });
});

describe("title route under restrictions", () => {
  it("uses the titles default, falls back to the project default, else skips", () => {
    project("tr");
    db().insert(conversations).values({ id: "c_tr", projectId: "tr", createdAt: 1, updatedAt: 1 }).onConflictDoNothing().run();
    expect(titleRouteFor(db(), "c_tr")).toEqual({ provider: "glm", model: "glm-5.3-flash" });
    setProjectModels(db(), "tr", { allowedProviders: ["gloo"] });
    expect(titleRouteFor(db(), "c_tr")).toBeNull();
    setProjectModels(db(), "tr", { defaultRoute: { provider: "gloo", model: "gloo-qwen-3.8-flash" } });
    expect(titleRouteFor(db(), "c_tr")).toEqual({ provider: "gloo", model: "gloo-qwen-3.8-flash" });
    expect(getConversation(db(), "c_tr")?.route).toBeNull();
  });
});

describe("visit route resolution (the run's layers, recorded)", () => {
  it("run-stage > run > stage > project > global, recorded on the visit row", async () => {
    const { resolveVisitRoute } = await import("../workflows/machines/steps");
    const { beginStageRun, listStageRuns } = await import("../db/machines");
    project("vr");
    setProjectModels(db(), "vr", { defaultRoute: { provider: "gloo", model: "gloo-kimi-k3" } });
    createMachine(db(), {
      id: "vr-m",
      name: "vr",
      definition: {
        workspace: "project",
        start: "a",
        stages: {
          a: { kind: "agent", title: "A", instructions: "", next: [{ to: "b" }] },
          b: { kind: "agent", title: "B", instructions: "", next: [{ to: "c" }], route: { provider: "glm", model: "glm-5.3" } },
          c: { kind: "harness", harness: "claude", title: "C", instructions: "", next: [] },
        },
      },
    });
    const plain = createRun(db(), { machineId: "vr-m", prompt: "go", projectId: "vr" });
    beginStageRun(db(), { runId: plain.id, seq: 0, stageId: "a", kind: "agent" });
    beginStageRun(db(), { runId: plain.id, seq: 1, stageId: "b", kind: "agent" });
    expect(await resolveVisitRoute({ runId: plain.id, seq: 0, stageId: "a", surface: "agent" })).toEqual({
      route: { provider: "gloo", model: "gloo-kimi-k3" },
      layer: "project",
    });
    expect((await resolveVisitRoute({ runId: plain.id, seq: 1, stageId: "b", surface: "agent" })).layer).toBe("stage");
    const recorded = listStageRuns(db(), plain.id).map((v) => JSON.parse(v.route ?? "null"));
    expect(recorded.map((r) => r.layer)).toEqual(["project", "stage"]);

    const overridden = createRun(db(), {
      machineId: "vr-m",
      prompt: "go",
      projectId: "vr",
      overrides: { route: { provider: "glm", model: "glm-5.3-flash" }, stages: { b: { provider: "gloo", model: "gloo-openai-gpt-6-sol" } } },
    });
    expect((await resolveVisitRoute({ runId: overridden.id, seq: 0, stageId: "a", surface: "agent" })).layer).toBe("run");
    expect(await resolveVisitRoute({ runId: overridden.id, seq: 1, stageId: "b", surface: "agent" })).toEqual({
      route: { provider: "gloo", model: "gloo-openai-gpt-6-sol" },
      layer: "run-stage",
    });
  });

  it("a forbidden route fails the visit fatally with the reason", async () => {
    const { resolveVisitRoute } = await import("../workflows/machines/steps");
    project("vr2");
    setProjectModels(db(), "vr2", { allowedProviders: ["gloo"] });
    createMachine(db(), {
      id: "vr2-m",
      name: "vr2",
      definition: { workspace: "project", start: "a", stages: { a: { kind: "agent", title: "A", instructions: "", next: [] } } },
    });
    const run = createRun(db(), { machineId: "vr2-m", prompt: "go", projectId: "vr2" });
    await expect(resolveVisitRoute({ runId: run.id, seq: 0, stageId: "a", surface: "agent" })).rejects.toThrow(
      /does not allow provider glm/,
    );
  });
});
