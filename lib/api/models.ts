/**
 * 0021 model routes: the pickers' catalog reads (GET /api/models,
 * GET /api/settings) and the settings writes (surface defaults, the
 * OpenRouter refresh). `thinking` and restriction validation happen
 * server-side; these are transport only.
 */

import type { ModelsView } from "@/lib/providers/catalog-view";
import type { GlobalDefaults, Surface, SurfaceRoute } from "@/lib/providers/route";
import { apiFetch, apiError, jsonInit } from "./core";

/**
 * The picker catalog, project-filtered with `projectId`. Null on any
 * HTTP failure; NETWORK ERRORS REJECT — the pickers that want
 * best-effort add `.catch(() => null)` and keep their old list.
 */
export async function getModelsView(projectId?: string): Promise<ModelsView | null> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await apiFetch<ModelsView>(`/api/models${qs}`, { cache: "no-store" });
  return res.ok ? res.body : null;
}

/** /settings' own catalog read (same ModelsView; no project filter). */
export async function getSettingsView(): Promise<ModelsView | null> {
  const res = await apiFetch<ModelsView>("/api/settings", { cache: "no-store" });
  return res.ok ? res.body : null;
}

/**
 * Save a surface's default route (PUT /api/settings). `{defaults}` on
 * success — the saved table, re-read server-side; on failure the
 * endpoint's zod `error` or the status fallback. Network errors reject.
 */
export async function saveSurfaceDefault<S extends Surface>(
  surface: S,
  route: SurfaceRoute<S>,
): Promise<{ ok: true; defaults: GlobalDefaults } | { ok: false; error: string }> {
  const res = await apiFetch<{ defaults?: GlobalDefaults }>("/api/settings", jsonInit("PUT", { surface, route }));
  if (res.ok && res.body?.defaults) return { ok: true, defaults: res.body.defaults };
  return { ok: false, error: apiError(res, "failed") };
}

/**
 * POST /api/models/refresh — re-fetch OpenRouter's tool-capable list
 * into `provider_models`. `{count}` on success (the endpoint always
 * sends it); on failure the endpoint's `error` or `refresh failed
 * (status)`. Network errors reject.
 */
export async function refreshModels(): Promise<
  { ok: true; count: number | undefined } | { ok: false; error: string }
> {
  const res = await apiFetch<{ error?: string; count?: number }>("/api/models/refresh", { method: "POST" });
  if (res.ok) return { ok: true, count: res.body?.count };
  return { ok: false, error: apiError(res, "refresh failed") };
}
