import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import {
  catalogHas,
  getGlobalDefaults,
  getProjectModels,
  listProviderModels,
  replaceProviderModels,
  setGlobalDefault,
  setProjectModels,
} from "../db/providers";
import { projects, providerModels, settings } from "../db/schema";
import { GLM_MODELS, GLOO_MODELS } from "../lib/providers/catalog";
import { ensureOpenRouterCatalog, parseOpenRouterModels } from "../lib/providers/openrouter";
import { fillToolDescriptions } from "../lib/providers/registry";
import { checkRoute } from "../lib/providers/resolve";
import {
  BUILTIN_DEFAULTS,
  checkRestrictions,
  parseRouteAs,
  resolveRoute,
  routeSchema,
  titleRoute,
  validateRoute,
  type ValidationContext,
} from "../lib/providers/route";

/** 0021: route shape, resolution layers, validation, the Gloo fix, catalogs. */

const KEYS = ["ZAI_API_KEY", "GLOO_API_KEY", "OPENROUTER_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.ZAI_API_KEY = "test-zai";
  process.env.GLOO_API_KEY = "test-gloo";
  process.env.OPENROUTER_API_KEY = "test-or";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-claude";
  db().delete(settings).run();
  db().delete(providerModels).run();
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

describe("route schema", () => {
  it("accepts the three shapes", () => {
    expect(routeSchema.safeParse({ provider: "gloo", model: "gloo-openai-gpt-6-sol" }).success).toBe(true);
    expect(routeSchema.safeParse({ harness: "pi", provider: "openrouter", model: "x/y", thinking: "high" }).success).toBe(true);
    expect(routeSchema.safeParse({ harness: "claude", model: "opus", effort: "max" }).success).toBe(true);
    expect(routeSchema.safeParse({ harness: "claude" }).success).toBe(true);
  });

  it("has nowhere to put a provider on claude (ToS by construction)", () => {
    expect(routeSchema.safeParse({ harness: "claude", provider: "openrouter", model: "opus" }).success).toBe(false);
  });

  it("rejects unknown providers with value-shaped issues", () => {
    const r = parseRouteAs(routeSchema, { provider: "openai", model: "gpt" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThan(0);
  });
});

describe("resolveRoute layers", () => {
  const g = BUILTIN_DEFAULTS;
  const conv = { provider: "gloo" as const, model: "gloo-openai-gpt-6-sol" };
  const proj = { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4.6" };

  it("chat: conversation > project > global", () => {
    expect(resolveRoute("chat", { global: g })).toEqual({ route: g.chat, layer: "global" });
    expect(resolveRoute("chat", { global: g, project: proj }).layer).toBe("project");
    expect(resolveRoute("chat", { global: g, project: proj, conversation: conv })).toEqual({
      route: conv,
      layer: "conversation",
    });
  });

  it("agent: run-stage > run > stage > project > global", () => {
    const stage = { provider: "glm" as const, model: "glm-5.3" };
    const run = { provider: "gloo" as const, model: "gloo-kimi-k3" };
    expect(resolveRoute("agent", { global: g, project: proj, stage }).layer).toBe("stage");
    expect(resolveRoute("agent", { global: g, project: proj, stage, run }).layer).toBe("run");
    expect(resolveRoute("agent", { global: g, project: proj, stage, run, runStage: conv })).toEqual({
      route: conv,
      layer: "run-stage",
    });
    expect(resolveRoute("agent", { global: g, project: proj }).layer).toBe("project");
  });

  it("pi inherits a chat-shaped conversation/project route as a pi route", () => {
    expect(resolveRoute("pi", { global: g, conversation: conv }).route).toEqual({ harness: "pi", ...conv });
    expect(resolveRoute("pi", { global: g, project: proj }).route).toEqual({ harness: "pi", ...proj });
    expect(resolveRoute("pi", { global: g })).toEqual({ route: g.pi, layer: "global" });
  });

  it("pi stage beats conversation; a claude stage route never applies to pi", () => {
    const piStage = { harness: "pi" as const, provider: "glm" as const, model: "glm-5.3", thinking: "high" as const };
    expect(resolveRoute("pi", { global: g, conversation: conv, stage: piStage })).toEqual({
      route: piStage,
      layer: "stage",
    });
    expect(resolveRoute("pi", { global: g, stage: { harness: "claude", model: "opus" } }).layer).toBe("global");
  });

  it("claude never inherits a chat/project/run route (decision 1)", () => {
    expect(resolveRoute("claude", { global: g, conversation: conv, project: proj, run: conv })).toEqual({
      route: g.claude,
      layer: "global",
    });
    expect(resolveRoute("claude", { global: g, stage: { harness: "claude", model: "opus" } }).route).toEqual({
      harness: "claude",
      model: "opus",
    });
    expect(
      resolveRoute("claude", { global: g, stage: { harness: "claude" }, runStage: { harness: "claude", effort: "max" } }),
    ).toEqual({ route: { harness: "claude", effort: "max" }, layer: "run-stage" });
  });

  it("titles always start from the titles default", () => {
    expect(resolveRoute("titles", { global: g, conversation: conv, project: proj }).route).toEqual(g.titles);
  });
});

describe("validateRoute", () => {
  const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
    availableProviders: new Set(["glm", "gloo", "openrouter"]),
    hasModel: () => true,
    claudeConfigured: true,
    project: null,
    ...over,
  });

  it("passes a well-formed route", () => {
    expect(validateRoute({ provider: "glm", model: "glm-5.3" }, ctx())).toEqual({ ok: true });
  });

  it("rejects an unavailable provider", () => {
    const r = validateRoute({ provider: "gloo", model: "gloo-kimi-k3" }, ctx({ availableProviders: new Set(["glm"]) }));
    expect(r).toEqual({ ok: false, issues: [expect.stringContaining("not configured")] });
  });

  it("rejects an unknown model, accepts an unfetched dynamic catalog", () => {
    expect(validateRoute({ provider: "glm", model: "nope" }, ctx({ hasModel: () => false })).ok).toBe(false);
    expect(validateRoute({ provider: "openrouter", model: "a/b" }, ctx({ hasModel: () => "unknown" })).ok).toBe(true);
  });

  it("rejects claude when its token is unset", () => {
    expect(validateRoute({ harness: "claude" }, ctx({ claudeConfigured: false })).ok).toBe(false);
  });

  it("enforces project restrictions on provider and harness", () => {
    const project = { id: "p", allowedProviders: ["gloo"] as const, allowedHarnesses: ["pi"] as const };
    expect(validateRoute({ provider: "glm", model: "glm-5.3" }, ctx({ project })).ok).toBe(false);
    expect(validateRoute({ provider: "gloo", model: "gloo-kimi-k3" }, ctx({ project })).ok).toBe(true);
    expect(validateRoute({ harness: "claude" }, ctx({ project })).ok).toBe(false);
    expect(validateRoute({ harness: "pi", provider: "gloo", model: "gloo-kimi-k3" }, ctx({ project })).ok).toBe(true);
  });

  it("an unset restriction list allows everything", () => {
    expect(checkRestrictions({ harness: "claude" }, { id: "p", allowedProviders: null, allowedHarnesses: null })).toEqual([]);
  });
});

describe("titleRoute", () => {
  it("uses the titles default when allowed", () => {
    expect(titleRoute(BUILTIN_DEFAULTS, null)).toEqual(BUILTIN_DEFAULTS.titles);
  });

  it("falls back to the project's default when the titles provider is forbidden", () => {
    const def = { provider: "gloo" as const, model: "gloo-qwen-3.8-flash" };
    expect(titleRoute(BUILTIN_DEFAULTS, { id: "p", allowedProviders: ["gloo"], defaultRoute: def })).toEqual(def);
  });

  it("skips the title rather than break a restriction", () => {
    expect(titleRoute(BUILTIN_DEFAULTS, { id: "p", allowedProviders: ["gloo"], defaultRoute: null })).toBeNull();
  });
});

describe("Gloo tool-description fix", () => {
  it("fills a missing or blank description with the tool name", () => {
    const body = {
      model: "m",
      tools: [
        { type: "function", function: { name: "ping", parameters: {} } },
        { type: "function", function: { name: "pong", description: "  ", parameters: {} } },
        { type: "function", function: { name: "keep", description: "kept", parameters: {} } },
      ],
    };
    const out = fillToolDescriptions(body);
    expect(out.tools.map((t) => t.function.description)).toEqual(["ping", "pong", "kept"]);
    expect(body.tools[0].function).not.toHaveProperty("description"); // input untouched
  });

  it("passes a body without tools through", () => {
    const body = { model: "m", messages: [] };
    expect(fillToolDescriptions(body)).toBe(body);
  });
});

describe("catalogs", () => {
  it("static catalogs have unique ids and usable sizing", () => {
    for (const list of [GLM_MODELS, GLOO_MODELS]) {
      expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
      for (const m of list) {
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.maxTokens).toBeGreaterThan(0);
        expect(m.label).toBeTruthy();
      }
    }
  });

  it("parses OpenRouter: keeps tool-capable text models only", () => {
    const models = parseOpenRouterModels({
      data: [
        {
          id: "anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet",
          context_length: 1_000_000,
          supported_parameters: ["tools", "temperature"],
          architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
          top_provider: { max_completion_tokens: 64_000 },
        },
        { id: "no/tools", supported_parameters: ["temperature"], architecture: { output_modalities: ["text"] } },
        { id: "img/out", supported_parameters: ["tools"], architecture: { output_modalities: ["image"] } },
      ],
    });
    expect(models).toEqual([
      { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet", contextWindow: 1_000_000, maxTokens: 64_000, vision: true },
    ]);
  });

  it("OpenRouter catalog is 'unknown' until fetched, then exact", () => {
    expect(catalogHas(db(), "openrouter", "a/b")).toBe("unknown");
    replaceProviderModels(db(), "openrouter", [{ id: "a/b", label: "AB", contextWindow: 1000, maxTokens: 100 }]);
    expect(catalogHas(db(), "openrouter", "a/b")).toBe(true);
    expect(catalogHas(db(), "openrouter", "c/d")).toBe(false);
    expect(listProviderModels(db(), "openrouter").map((m) => m.id)).toEqual(["a/b"]);
  });

  it("ensureOpenRouterCatalog skips a fresh cache", async () => {
    replaceProviderModels(db(), "openrouter", [{ id: "a/b", label: "AB", contextWindow: 1000, maxTokens: 100 }]);
    const spy = vi.spyOn(globalThis, "fetch");
    await ensureOpenRouterCatalog(db());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("store + checkRoute", () => {
  it("global defaults fall back to built-ins and round-trip", () => {
    expect(getGlobalDefaults(db())).toEqual(BUILTIN_DEFAULTS);
    setGlobalDefault(db(), "chat", { provider: "gloo", model: "gloo-kimi-k3" });
    expect(getGlobalDefaults(db()).chat).toEqual({ provider: "gloo", model: "gloo-kimi-k3" });
    setGlobalDefault(db(), "chat", null);
    expect(getGlobalDefaults(db()).chat).toEqual(BUILTIN_DEFAULTS.chat);
  });

  it("a malformed stored default is ignored, not fatal", () => {
    db().insert(settings).values({ key: "default_route.chat", value: "{bad", updatedAt: 0 }).run();
    expect(getGlobalDefaults(db()).chat).toEqual(BUILTIN_DEFAULTS.chat);
  });

  it("project models round-trip, unknown list entries drop", () => {
    project("pm");
    setProjectModels(db(), "pm", {
      defaultRoute: { provider: "gloo", model: "gloo-kimi-k3" },
      allowedProviders: ["gloo"],
      allowedHarnesses: ["pi"],
    });
    expect(getProjectModels(db(), "pm")).toEqual({
      id: "pm",
      defaultRoute: { provider: "gloo", model: "gloo-kimi-k3" },
      allowedProviders: ["gloo"],
      allowedHarnesses: ["pi"],
    });
    setProjectModels(db(), "pm", { allowedProviders: null });
    expect(getProjectModels(db(), "pm")?.allowedProviders).toBeNull();
  });

  it("checkRoute: project default applies, and restrictions reject at every layer", () => {
    project("restricted");
    setProjectModels(db(), "restricted", {
      defaultRoute: { provider: "gloo", model: "gloo-kimi-k3" },
      allowedProviders: ["gloo"],
      allowedHarnesses: ["pi"],
    });
    const viaProject = checkRoute(db(), "chat", {}, "restricted");
    expect(viaProject).toMatchObject({ ok: true, layer: "project", route: { provider: "gloo" } });
    // A conversation route on a forbidden provider is rejected, never swapped.
    const forbidden = checkRoute(db(), "chat", { conversation: { provider: "glm", model: "glm-5.3" } }, "restricted");
    expect(forbidden).toEqual({ ok: false, issues: [expect.stringContaining("does not allow provider glm")] });
    // claude (global default) is a forbidden harness here.
    expect(checkRoute(db(), "claude", {}, "restricted").ok).toBe(false);
    // pi inherits the project default (gloo) and is allowed.
    expect(checkRoute(db(), "pi", {}, "restricted")).toMatchObject({ ok: true, route: { harness: "pi", provider: "gloo" } });
  });

  it("checkRoute reports a missing key clearly", () => {
    delete process.env.GLOO_API_KEY;
    const r = checkRoute(db(), "chat", { conversation: { provider: "gloo", model: "gloo-kimi-k3" } }, null);
    expect(r).toEqual({ ok: false, issues: [expect.stringContaining("Gloo is not configured")] });
  });
});
