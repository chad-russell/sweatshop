import { z } from "zod";
import { CODEX_MODELS, CURSOR_MODELS, PROVIDER_IDS, PROVIDER_LABELS, type ProviderId } from "./catalog";

/**
 * 0021: the route — the one value that says what runs a model call.
 * Pure (zod + plain functions): imported by the workflow bodies, the
 * stores, the routes, and the client pickers.
 *
 * Provider-routed surfaces (chats, agent stages, titles, pi) carry a
 * provider + model. The subscription harnesses (claude, cursor — 0038,
 * codex — 0050) carry only what the subscription offers — the schema
 * has nowhere to put a provider on them, so "never repoint a
 * subscription harness" holds by construction (decision 1).
 */

export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export const ROUTE_HARNESSES = ["pi", "claude", "cursor", "codex"] as const;
export type RouteHarness = (typeof ROUTE_HARNESSES)[number];

const providerId = z.enum(PROVIDER_IDS);
const modelId = z.string().min(1).max(200);

/** In-process agent: chats, agent stages, titles. `thinking` follows
 *  the model's capability — rejected by validateRoute when the catalog
 *  says the model has none (0021 amendment). */
export const chatRouteSchema = z.strictObject({
  provider: providerId,
  model: modelId,
  thinking: z.enum(THINKING_LEVELS).optional(),
});
export const piRouteSchema = z.strictObject({
  harness: z.literal("pi"),
  provider: providerId,
  model: modelId,
  thinking: z.enum(THINKING_LEVELS).optional(),
});
export const claudeRouteSchema = z.strictObject({
  harness: z.literal("claude"),
  model: modelId.optional(),
  effort: z.enum(CLAUDE_EFFORTS).optional(),
});
/** 0038: Cursor — subscription only (browser-login auth.json); the model
 *  is a Cursor CLI model id, unset = Cursor's own default ("auto"). */
export const cursorRouteSchema = z.strictObject({
  harness: z.literal("cursor"),
  model: modelId.optional(),
});
/** 0050: Codex — subscription only (ChatGPT-login auth.json). The
 *  model must be PINNED: the adapter's own default (gpt-5.5) is
 *  API-key-era stale and the backend rejects it on subscriptions
 *  (live 2026-10-19) — see BUILTIN_DEFAULTS.codex and CODEX_MODELS.
 *  Codex accepts the same effort ladder as claude (createCodex
 *  reasoningEffort). */
export const codexRouteSchema = z.strictObject({
  harness: z.literal("codex"),
  model: modelId.optional(),
  effort: z.enum(CLAUDE_EFFORTS).optional(),
});
export const harnessRouteSchema = z.discriminatedUnion("harness", [
  piRouteSchema,
  claudeRouteSchema,
  cursorRouteSchema,
  codexRouteSchema,
]);
export const routeSchema = z.union([harnessRouteSchema, chatRouteSchema]);

export type ChatRoute = z.infer<typeof chatRouteSchema>;
export type PiRoute = z.infer<typeof piRouteSchema>;
export type ClaudeRoute = z.infer<typeof claudeRouteSchema>;
export type CursorRoute = z.infer<typeof cursorRouteSchema>;
export type CodexRoute = z.infer<typeof codexRouteSchema>;
export type HarnessRoute = z.infer<typeof harnessRouteSchema>;
export type Route = z.infer<typeof routeSchema>;

/** Where a model call happens — each resolves through its own layers. */
export type Surface = "chat" | "agent" | "pi" | "claude" | "cursor" | "codex" | "titles";
export const SURFACES = ["chat", "agent", "pi", "claude", "cursor", "codex", "titles"] as const satisfies readonly Surface[];
export type SurfaceRoute<S extends Surface> = S extends "pi"
  ? PiRoute
  : S extends "claude"
    ? ClaudeRoute
    : S extends "cursor"
      ? CursorRoute
      : S extends "codex"
        ? CodexRoute
        : ChatRoute;

/** Which layer a resolved route came from — recorded with every visit/turn. */
export type RouteLayer = "run-stage" | "run" | "stage" | "conversation" | "project" | "global";

export interface Resolved<S extends Surface> {
  route: SurfaceRoute<S>;
  layer: RouteLayer;
}

/** The per-surface global defaults (the settings rows; decision 3). */
export type GlobalDefaults = { [S in Surface]: SurfaceRoute<S> };

export const BUILTIN_DEFAULTS: GlobalDefaults = {
  chat: { provider: "glm", model: "glm-5.3-flash" },
  agent: { provider: "glm", model: "glm-5.3-flash" },
  pi: { harness: "pi", provider: "glm", model: "glm-5.3-flash" },
  claude: { harness: "claude" },
  cursor: { harness: "cursor" },
  // Model always pinned — an empty model would let the adapter send
  // its stale gpt-5.5 default, which subscriptions reject (live
  // 2026-10-19).
  codex: { harness: "codex", model: "gpt-5.6-sol" },
  titles: { provider: "glm", model: "glm-5.3-flash" },
};

/** A run's overrides (`startRun({ overrides })`; UI lands with 2.1). */
export const runOverridesSchema = z.strictObject({
  /** Whole run: provider-routed surfaces (agent stages, pi). */
  route: chatRouteSchema.optional(),
  /** Per stage id: the stage's own shape. */
  stages: z.record(z.string(), routeSchema).optional(),
});
export type RunOverrides = z.infer<typeof runOverridesSchema>;

export interface RouteLayers {
  /** run.overrides.stages[stageId] */
  runStage?: Route | null;
  /** run.overrides.route */
  run?: ChatRoute | null;
  stage?: Route | null;
  conversation?: ChatRoute | null;
  project?: ChatRoute | null;
  global: GlobalDefaults;
}

const isChat = (r: Route | null | undefined): r is ChatRoute => !!r && !("harness" in r);
const isPi = (r: Route | null | undefined): r is PiRoute => !!r && "harness" in r && r.harness === "pi";
const isClaude = (r: Route | null | undefined): r is ClaudeRoute =>
  !!r && "harness" in r && r.harness === "claude";
const isCursor = (r: Route | null | undefined): r is CursorRoute =>
  !!r && "harness" in r && r.harness === "cursor";
const isCodex = (r: Route | null | undefined): r is CodexRoute =>
  !!r && "harness" in r && r.harness === "codex";

/** A chat route carried onto pi (the chat's pi tool inherits its conversation's route). */
function asPi(r: ChatRoute | PiRoute): PiRoute {
  return isPi(r) ? r : { harness: "pi", provider: r.provider, model: r.model };
}

/**
 * Most specific wins, per surface (0021 §4):
 *   chat:   conversation > project > global
 *   titles: global (restrictions handled by the caller — see titleRoute)
 *   agent:  run-stage > run > stage > project > global
 *   pi:     run-stage > run > stage > conversation > project > global
 *   claude: run-stage > stage > global — never inherits a chat/project
 *           route (subscription harness, decision 1)
 *   cursor: same as claude (0038)
 *   codex:  same as claude (0050)
 * A layer whose value has the wrong shape for the surface is skipped.
 */
export function resolveRoute<S extends Surface>(surface: S, layers: RouteLayers): Resolved<S> {
  const pick = (): { route: Route; layer: RouteLayer } => {
    const g = layers.global;
    switch (surface) {
      case "chat":
        if (isChat(layers.conversation)) return { route: layers.conversation, layer: "conversation" };
        if (isChat(layers.project)) return { route: layers.project, layer: "project" };
        return { route: g.chat, layer: "global" };
      case "titles":
        return { route: g.titles, layer: "global" };
      case "agent":
        if (isChat(layers.runStage)) return { route: layers.runStage, layer: "run-stage" };
        if (isChat(layers.run)) return { route: layers.run, layer: "run" };
        if (isChat(layers.stage)) return { route: layers.stage, layer: "stage" };
        if (isChat(layers.project)) return { route: layers.project, layer: "project" };
        return { route: g.agent, layer: "global" };
      case "pi":
        if (isPi(layers.runStage) || isChat(layers.runStage))
          return { route: asPi(layers.runStage), layer: "run-stage" };
        if (isChat(layers.run)) return { route: asPi(layers.run), layer: "run" };
        if (isPi(layers.stage)) return { route: layers.stage, layer: "stage" };
        if (isChat(layers.conversation)) return { route: asPi(layers.conversation), layer: "conversation" };
        if (isChat(layers.project)) return { route: asPi(layers.project), layer: "project" };
        return { route: g.pi, layer: "global" };
      case "claude":
        if (isClaude(layers.runStage)) return { route: layers.runStage, layer: "run-stage" };
        if (isClaude(layers.stage)) return { route: layers.stage, layer: "stage" };
        return { route: g.claude, layer: "global" };
      case "cursor":
        if (isCursor(layers.runStage)) return { route: layers.runStage, layer: "run-stage" };
        if (isCursor(layers.stage)) return { route: layers.stage, layer: "stage" };
        return { route: g.cursor, layer: "global" };
      case "codex":
        if (isCodex(layers.runStage)) return { route: layers.runStage, layer: "run-stage" };
        if (isCodex(layers.stage)) return { route: layers.stage, layer: "stage" };
        return { route: g.codex, layer: "global" };
    }
    throw new Error(`unknown surface ${String(surface)}`);
  };
  return pick() as Resolved<S>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ProjectRestrictions {
  allowedProviders?: readonly ProviderId[] | null;
  allowedHarnesses?: readonly RouteHarness[] | null;
}

export interface ValidationContext {
  /** Providers whose key is present. */
  availableProviders: ReadonlySet<ProviderId>;
  /** Whether the provider's catalog has the model ("unknown" = no catalog yet — accepted). */
  hasModel: (provider: ProviderId, model: string) => boolean | "unknown";
  /** The model's reasoning control ("none" | "switch" | "effort";
   *  "unknown" = dynamic catalog never fetched — accepted). */
  modelReasoning?: (provider: ProviderId, model: string) => "none" | "switch" | "effort" | "unknown";
  claudeConfigured: boolean;
  /** 0038: a usable Cursor browser-login credential exists. */
  cursorConfigured: boolean;
  /** 0050: a usable ChatGPT-login credential exists. */
  codexConfigured: boolean;
  project?: (ProjectRestrictions & { id: string }) | null;
}

export type RouteCheck = { ok: true } | { ok: false; issues: string[] };

/** The provider a route spends on (null for subscription harnesses). */
export function routeProvider(route: Route): ProviderId | null {
  return "provider" in route ? route.provider : null;
}

/** The harness a route runs on (null = in-process agent). */
export function routeHarness(route: Route): RouteHarness | null {
  return "harness" in route ? route.harness : null;
}

/** Project restriction check alone (applied after resolution, at every layer). */
export function checkRestrictions(route: Route, project: ValidationContext["project"]): string[] {
  if (!project) return [];
  const issues: string[] = [];
  const provider = routeProvider(route);
  const harness = routeHarness(route);
  if (provider && project.allowedProviders && !project.allowedProviders.includes(provider)) {
    issues.push(
      `project "${project.id}" does not allow provider ${provider} (allowed: ${project.allowedProviders.join(", ") || "none"})`,
    );
  }
  if (harness && project.allowedHarnesses && !project.allowedHarnesses.includes(harness)) {
    issues.push(
      `project "${project.id}" does not allow the ${harness} harness (allowed: ${project.allowedHarnesses.join(", ") || "none"})`,
    );
  }
  return issues;
}

/** Full check of one route — value-shaped so agent tools can repair it. */
export function validateRoute(route: Route, ctx: ValidationContext): RouteCheck {
  const issues: string[] = [];
  const provider = routeProvider(route);
  if (provider) {
    if (!ctx.availableProviders.has(provider)) {
      issues.push(`provider ${PROVIDER_LABELS[provider]} is not configured (its API key is not set)`);
    } else if (ctx.hasModel(provider, (route as ChatRoute).model) === false) {
      issues.push(`model "${(route as ChatRoute).model}" is not in ${PROVIDER_LABELS[provider]}'s catalog`);
    }
  }
  // 0021 amendment: a thinking level a model cannot honor is rejected,
  // never silently sent (effort params 400 on non-reasoning models).
  // pi's own thinking is exempt — harness-pi holds that knob.
  if (!routeHarness(route) && (route as ChatRoute).thinking && provider && ctx.modelReasoning) {
    if (ctx.modelReasoning(provider, (route as ChatRoute).model) === "none") {
      issues.push(
        `model "${(route as ChatRoute).model}" exposes no thinking/reasoning control — unset thinking`,
      );
    }
  }
  if (routeHarness(route) === "claude" && !ctx.claudeConfigured) {
    issues.push("claude is not configured (CLAUDE_CODE_OAUTH_TOKEN is not set)");
  }
  if (isCursor(route) && route.model && !CURSOR_MODELS.some((m) => m.id === route.model)) {
    issues.push(
      `cursor model "${route.model}" is not one Cursor's ACP accepts (offered: ${CURSOR_MODELS.map((m) => m.id).join(", ")}) — pick one on /settings or clear it`,
    );
  }
  if (routeHarness(route) === "cursor" && !ctx.cursorConfigured) {
    issues.push(
      "cursor is not logged in — run `agent login` and save its auth.json (data/harness-auth/cursor/auth.json), see /settings",
    );
  }
  // 0050 review: the model is REQUIRED at validation, not in the
  // schema — stored legacy bare routes still parse, but nothing runs
  // them. BUILTIN_DEFAULTS pins gpt-5.6-sol, so the reset path is safe.
  if (isCodex(route) && !route.model) {
    issues.push(
      "codex routes must pin a model — the adapter's own default (gpt-5.5) is rejected on ChatGPT accounts (live 2026-10-19); pick one on /settings",
    );
  }
  if (isCodex(route) && route.model && !CODEX_MODELS.some((m) => m.id === route.model)) {
    issues.push(
      `codex model "${route.model}" is not offered (offered: ${CODEX_MODELS.map((m) => m.id).join(", ")}) — pick one on /settings or clear it`,
    );
  }
  if (routeHarness(route) === "codex" && !ctx.codexConfigured) {
    issues.push("codex is not logged in — use Log in with ChatGPT on /settings (data/harness-auth/codex/auth.json)");
  }
  issues.push(...checkRestrictions(route, ctx.project));
  return issues.length ? { ok: false, issues } : { ok: true };
}

/** Parse an unknown value as a route of the given shape; value-shaped errors. */
export function parseRouteAs<T>(
  schema: z.ZodType<T>,
  value: unknown,
): { ok: true; route: T } | { ok: false; issues: string[] } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, route: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.length ? issue.path.join(".") : "route"}: ${issue.message}`,
    ),
  };
}

/** Short display, e.g. "Gloo · gloo-openai-gpt-6-sol", "claude · opus". */
export function routeLabel(route: Route): string {
  if (isCursor(route)) return `cursor${route.model ? ` · ${route.model}` : ""}`;
  if (isClaude(route)) return `claude${route.model ? ` · ${route.model}` : ""}${route.effort ? ` (${route.effort})` : ""}`;
  if (isCodex(route)) return `codex${route.model ? ` · ${route.model}` : ""}${route.effort ? ` (${route.effort})` : ""}`;
  const r = route as ChatRoute | PiRoute;
  const prefix = isPi(r) ? "pi · " : "";
  const thinking = r.thinking ? ` (${r.thinking})` : "";
  return `${prefix}${PROVIDER_LABELS[r.provider]} · ${r.model}${thinking}`;
}

/**
 * The route a title call uses (0021 §5): the titles default, unless the
 * conversation's project forbids its provider — then the project's own
 * default route (itself required to be allowed), else null (skip the
 * title rather than break the restriction).
 */
export function titleRoute(
  global: GlobalDefaults,
  project: (ProjectRestrictions & { id: string; defaultRoute?: ChatRoute | null }) | null,
): ChatRoute | null {
  const route = global.titles;
  if (checkRestrictions(route, project).length === 0) return route;
  if (project?.defaultRoute && checkRestrictions(project.defaultRoute, project).length === 0) {
    return project.defaultRoute;
  }
  return null;
}
