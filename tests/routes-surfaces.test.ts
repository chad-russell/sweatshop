import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { getConversation } from "../db/chat";
import { getGlobalDefaults, getProjectModels, setProjectModels } from "../db/providers";
import { conversations, projects, settings } from "../db/schema";
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

