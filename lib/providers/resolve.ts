import { FatalError } from "workflow";
import type { Db } from "../../db";
import {
  catalogHas,
  getGlobalDefaults,
  getProjectModels,
  type ProjectModels,
} from "../../db/providers";
import { availableProviders } from "./registry";
import {
  resolveRoute,
  validateRoute,
  type RouteLayers,
  type Resolved,
  type Surface,
  type ValidationContext,
} from "./route";

/**
 * 0021: the server-side resolution service — the one place a consumer
 * turns layers into a checked route. Store reads + env, so Node-only
 * (call from steps and routes, never the workflow body).
 *
 * Restrictions apply AFTER resolution, at every layer: a resolved route
 * the project forbids is rejected (never silently swapped — 0021 §4).
 * Provider availability and catalog membership are checked too, so a
 * missing key surfaces as a clear message instead of a 401 mid-turn.
 */

export function validationContext(db: Db, project: ProjectModels | null): ValidationContext {
  return {
    availableProviders: availableProviders(),
    hasModel: (provider, model) => catalogHas(db, provider, model),
    claudeConfigured: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
    project: project
      ? { id: project.id, allowedProviders: project.allowedProviders, allowedHarnesses: project.allowedHarnesses }
      : null,
  };
}

export class RouteError extends Error {
  constructor(
    readonly surface: Surface,
    readonly issues: string[],
  ) {
    super(`cannot run ${surface}: ${issues.join("; ")}`);
    this.name = "RouteError";
  }
}

export type CheckedRoute<S extends Surface> =
  | ({ ok: true } & Resolved<S>)
  | { ok: false; issues: string[] };

/**
 * Resolve a surface's route for a project (layers other than project and
 * global are the caller's), then validate it. `projectId` null = no
 * project (no restrictions, no project default).
 */
export function checkRoute<S extends Surface>(
  db: Db,
  surface: S,
  layers: Omit<RouteLayers, "global" | "project">,
  projectId: string | null | undefined,
): CheckedRoute<S> {
  const project = getProjectModels(db, projectId);
  const resolved = resolveRoute(surface, {
    ...layers,
    project: project?.defaultRoute ?? null,
    global: getGlobalDefaults(db),
  });
  const check = validateRoute(resolved.route, validationContext(db, project));
  if (!check.ok) return { ok: false, issues: check.issues };
  return { ok: true, ...resolved };
}

/**
 * checkRoute that throws (for steps, where a failure fails the turn or
 * visit). A route problem is deterministic — a missing key or a project
 * restriction will not fix itself on retry — so it is thrown as the
 * Workflow SDK's FatalError (no step retries), carrying the reasons.
 */
export function requireRoute<S extends Surface>(
  db: Db,
  surface: S,
  layers: Omit<RouteLayers, "global" | "project">,
  projectId: string | null | undefined,
): Resolved<S> {
  const r = checkRoute(db, surface, layers, projectId);
  if (!r.ok) throw new FatalError(new RouteError(surface, r.issues).message);
  return { route: r.route, layer: r.layer };
}
