import type { Db } from "../../db";
import {
  getProjectModels,
  setGlobalDefault,
  setProjectModels,
  surfaceSchema,
  type ProjectModels,
} from "../../db/providers";
import { PROVIDER_IDS } from "./catalog";
import { validationContext } from "./resolve";
import type { z } from "zod";
import {
  chatRouteSchema,
  checkRestrictions,
  parseRouteAs,
  ROUTE_HARNESSES,
  SURFACES,
  validateRoute,
  type ChatRoute,
  type Route,
  type Surface,
  type SurfaceRoute,
} from "./route";

/**
 * 0021: the one write path for the per-surface global defaults — shared
 * by `PUT /api/settings` and (later, 2.4) an agent tool, the 0015
 * pattern. Value-shaped results so a caller can repair. `route: null`
 * resets the surface to its built-in default.
 */
export function setDefaultRoute(
  db: Db,
  surface: unknown,
  route: unknown,
): { ok: true } | { ok: false; issues: string[] } {
  if (typeof surface !== "string" || !(SURFACES as readonly string[]).includes(surface)) {
    return { ok: false, issues: [`surface must be one of ${SURFACES.join(", ")}`] };
  }
  const s = surface as Surface;
  if (route === null) {
    setGlobalDefault(db, s, null);
    return { ok: true };
  }
  const parsed = parseRouteAs<Route>(surfaceSchema(s) as z.ZodType<Route>, route);
  if (!parsed.ok) return parsed;
  // Globals sit under every project; restrictions are checked per
  // project at resolution, so validate availability + catalog only.
  const check = validateRoute(parsed.route, validationContext(db, null));
  if (!check.ok) return check;
  setGlobalDefault(db, s, parsed.route as SurfaceRoute<Surface>);
  return { ok: true };
}

/**
 * 0021 §4 / decision 4: write a project's model settings — default route
 * and the optional allowed-providers / allowed-harnesses lists (each
 * field: absent = untouched, null = clear). The resulting combination
 * must be coherent: the default route must itself be allowed, and
 * available. Value-shaped; shared by the route and (2.4) an agent tool.
 */
export function setProjectModelSettings(
  db: Db,
  projectId: string,
  input: { defaultRoute?: unknown; allowedProviders?: unknown; allowedHarnesses?: unknown },
): { ok: true; models: ProjectModels } | { ok: false; issues: string[]; notFound?: true } {
  const current = getProjectModels(db, projectId);
  if (!current) return { ok: false, issues: [`project ${projectId} not found`], notFound: true };
  const issues: string[] = [];

  const list = <T extends string>(value: unknown, allowed: readonly T[], field: string): T[] | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !(allowed as readonly string[]).includes(v))) {
      issues.push(`${field} must be null or a list of: ${allowed.join(", ")}`);
      return undefined;
    }
    return [...new Set(value as T[])];
  };
  const allowedProviders = list(input.allowedProviders, PROVIDER_IDS, "allowedProviders");
  const allowedHarnesses = list(input.allowedHarnesses, ROUTE_HARNESSES, "allowedHarnesses");

  let defaultRoute: ChatRoute | null | undefined;
  if (input.defaultRoute === null) defaultRoute = null;
  else if (input.defaultRoute !== undefined) {
    const parsed = parseRouteAs(chatRouteSchema, input.defaultRoute);
    if (!parsed.ok) issues.push(...parsed.issues.map((i) => `defaultRoute: ${i}`));
    else defaultRoute = parsed.route;
  }
  if (issues.length) return { ok: false, issues };

  const next: ProjectModels = {
    id: projectId,
    defaultRoute: defaultRoute === undefined ? current.defaultRoute : defaultRoute,
    allowedProviders: allowedProviders === undefined ? current.allowedProviders : allowedProviders,
    allowedHarnesses: allowedHarnesses === undefined ? current.allowedHarnesses : allowedHarnesses,
  };
  if (next.defaultRoute) {
    // Only re-validate availability/catalog when the route itself changed;
    // a restriction change still has to keep the existing default allowed.
    const check =
      defaultRoute !== undefined
        ? validateRoute(next.defaultRoute, validationContext(db, next))
        : { ok: checkRestrictions(next.defaultRoute, next).length === 0, issues: checkRestrictions(next.defaultRoute, next) };
    if (!check.ok) return { ok: false, issues: (check as { issues: string[] }).issues.map((i) => `defaultRoute: ${i}`) };
  }
  setProjectModels(db, projectId, {
    ...(defaultRoute !== undefined ? { defaultRoute } : {}),
    ...(allowedProviders !== undefined ? { allowedProviders } : {}),
    ...(allowedHarnesses !== undefined ? { allowedHarnesses } : {}),
  });
  return { ok: true, models: getProjectModels(db, projectId)! };
}
