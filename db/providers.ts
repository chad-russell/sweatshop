import { eq, sql } from "drizzle-orm";
import type { Db } from "./index";
import { projects, providerModels, settings } from "./schema";
import { staticModels, type ModelInfo, type ProviderId } from "../lib/providers/catalog";
import {
  BUILTIN_DEFAULTS,
  SURFACES,
  chatRouteSchema,
  claudeRouteSchema,
  piRouteSchema,
  type ChatRoute,
  type GlobalDefaults,
  type RouteHarness,
  type Surface,
  type SurfaceRoute,
} from "../lib/providers/route";
import { PROVIDER_IDS } from "../lib/providers/catalog";

/**
 * 0021 store: global per-surface default routes (`settings`), the cached
 * OpenRouter catalog (`provider_models`), and the project's model
 * columns. Parsing is tolerant on read — a malformed stored value falls
 * back to the built-in default rather than failing a turn.
 */

const settingKey = (surface: Surface) => `default_route.${surface}`;

const SURFACE_SCHEMA = {
  chat: chatRouteSchema,
  agent: chatRouteSchema,
  titles: chatRouteSchema,
  pi: piRouteSchema,
  claude: claudeRouteSchema,
} as const;

export function surfaceSchema(surface: Surface) {
  return SURFACE_SCHEMA[surface];
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getGlobalDefaults(db: Db): GlobalDefaults {
  const rows = db.select().from(settings).all();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...BUILTIN_DEFAULTS } as Record<Surface, unknown>;
  for (const surface of SURFACES) {
    const parsed = SURFACE_SCHEMA[surface].safeParse(parseJson(byKey.get(settingKey(surface))));
    if (parsed.success) out[surface] = parsed.data;
  }
  return out as GlobalDefaults;
}

/** Set (or clear, with null) one surface's default. Caller validates. */
export function setGlobalDefault<S extends Surface>(db: Db, surface: S, route: SurfaceRoute<S> | null): void {
  const key = settingKey(surface);
  if (route === null) {
    db.delete(settings).where(eq(settings.key, key)).run();
    return;
  }
  const value = JSON.stringify(route);
  const now = Date.now();
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run();
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

/** Models a provider offers: static list, or the cached fetched list. */
export function listProviderModels(db: Db, provider: ProviderId): ModelInfo[] {
  const fixed = staticModels(provider);
  if (fixed) return [...fixed];
  return db
    .select()
    .from(providerModels)
    .where(eq(providerModels.provider, provider))
    .orderBy(providerModels.label)
    .all()
    .map((r) => ({
      id: r.id,
      label: r.label,
      contextWindow: r.contextWindow,
      maxTokens: r.maxTokens,
      ...(r.vision ? { vision: true } : {}),
    }));
}

/** true/false when the catalog is known; "unknown" when a dynamic catalog was never fetched. */
export function catalogHas(db: Db, provider: ProviderId, model: string): boolean | "unknown" {
  const fixed = staticModels(provider);
  if (fixed) return fixed.some((m) => m.id === model);
  const any = db
    .select({ n: sql<number>`count(*)` })
    .from(providerModels)
    .where(eq(providerModels.provider, provider))
    .get();
  if (!any || any.n === 0) return "unknown";
  return !!db
    .select({ id: providerModels.id })
    .from(providerModels)
    .where(sql`${providerModels.provider} = ${provider} and ${providerModels.id} = ${model}`)
    .get();
}

export function getModelInfo(db: Db, provider: ProviderId, model: string): ModelInfo | undefined {
  const fixed = staticModels(provider);
  if (fixed) return fixed.find((m) => m.id === model);
  const r = db
    .select()
    .from(providerModels)
    .where(sql`${providerModels.provider} = ${provider} and ${providerModels.id} = ${model}`)
    .get();
  return r
    ? { id: r.id, label: r.label, contextWindow: r.contextWindow, maxTokens: r.maxTokens, vision: r.vision }
    : undefined;
}

/** Unix ms of the last catalog fetch for a provider (null = never). */
export function catalogFetchedAt(db: Db, provider: ProviderId): number | null {
  const row = db
    .select({ at: sql<number | null>`max(${providerModels.fetchedAt})` })
    .from(providerModels)
    .where(eq(providerModels.provider, provider))
    .get();
  return row?.at ?? null;
}

/** Replace a provider's cached catalog in one transaction. */
export function replaceProviderModels(db: Db, provider: ProviderId, models: ModelInfo[], at = Date.now()): void {
  db.transaction((tx) => {
    tx.delete(providerModels).where(eq(providerModels.provider, provider)).run();
    for (const m of models) {
      tx.insert(providerModels)
        .values({
          provider,
          id: m.id,
          label: m.label,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          vision: !!m.vision,
          fetchedAt: at,
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

// ---------------------------------------------------------------------------
// Project model settings (0021 §4, decision 4)
// ---------------------------------------------------------------------------

export interface ProjectModels {
  id: string;
  defaultRoute: ChatRoute | null;
  allowedProviders: ProviderId[] | null;
  allowedHarnesses: RouteHarness[] | null;
}

function parseList<T extends string>(value: string | null, allowed: readonly T[]): T[] | null {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return null;
  return parsed.filter((v): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v));
}

export function getProjectModels(db: Db, projectId: string | null | undefined): ProjectModels | null {
  if (!projectId) return null;
  const row = db
    .select({
      id: projects.id,
      defaultRoute: projects.defaultRoute,
      allowedProviders: projects.allowedProviders,
      allowedHarnesses: projects.allowedHarnesses,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!row) return null;
  const route = chatRouteSchema.safeParse(parseJson(row.defaultRoute));
  return {
    id: row.id,
    defaultRoute: route.success ? route.data : null,
    allowedProviders: parseList(row.allowedProviders, PROVIDER_IDS),
    allowedHarnesses: parseList(row.allowedHarnesses, ["pi", "claude"] as const),
  };
}

/** Write a project's model settings (each field: undefined = untouched, null = clear). Caller validates. */
export function setProjectModels(
  db: Db,
  projectId: string,
  set: {
    defaultRoute?: ChatRoute | null;
    allowedProviders?: ProviderId[] | null;
    allowedHarnesses?: RouteHarness[] | null;
  },
): void {
  const values: Partial<typeof projects.$inferInsert> = {};
  if (set.defaultRoute !== undefined) values.defaultRoute = set.defaultRoute ? JSON.stringify(set.defaultRoute) : null;
  if (set.allowedProviders !== undefined)
    values.allowedProviders = set.allowedProviders ? JSON.stringify(set.allowedProviders) : null;
  if (set.allowedHarnesses !== undefined)
    values.allowedHarnesses = set.allowedHarnesses ? JSON.stringify(set.allowedHarnesses) : null;
  if (Object.keys(values).length === 0) return;
  db.update(projects).set(values).where(eq(projects.id, projectId)).run();
}

/** A stored conversation route (tolerant). */
export function parseStoredChatRoute(value: string | null | undefined): ChatRoute | null {
  const r = chatRouteSchema.safeParse(parseJson(value));
  return r.success ? r.data : null;
}
