/** 0090 §4/§5: the skills catalog's mutation endpoints. */

import type { CatalogEntry, CatalogList, CatalogSearch, SearchResult, SkillOrigin } from "@/lib/skills/catalog-source";
import { apiFetch, jsonInit } from "./core";

export type { CatalogEntry };

export interface SkillMutationResult {
  ok: boolean;
  code?: string;
  message?: string;
  id?: string;
}

export async function setSkillDisabledRequest(
  id: string,
  disabled: boolean,
): Promise<SkillMutationResult | { error: string }> {
  const res = await apiFetch<SkillMutationResult>(
    `/api/settings/skills/${encodeURIComponent(id)}/status`,
    jsonInit("PUT", { disabled }),
  );
  if (res.ok && res.body) return res.body;
  const error = (res.body as { error?: string } | null)?.error;
  return { error: error ?? `update failed (${res.status})` };
}

export async function deleteSkillRequest(id: string): Promise<SkillMutationResult | { error: string }> {
  const res = await apiFetch<SkillMutationResult>(`/api/settings/skills/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.ok && res.body) return res.body;
  const error = (res.body as { error?: string } | null)?.error;
  return { error: error ?? `delete failed (${res.status})` };
}

// ---- 0090 §7 + 0091 §1: public catalog discovery -----------------------------

export interface CatalogPreview {
  id: string;
  raw: string;
  sha: string;
  files: { path: string; size: number }[];
}

export type { SkillOrigin, SearchResult, CatalogSearch };

const DEFAULT_ORIGIN: SkillOrigin = { origin: "source", source: "anthropics" };

const originQuery = (origin: SkillOrigin) =>
  origin.origin === "source"
    ? origin.source === "anthropics"
      ? ""
      : `?source=${encodeURIComponent(origin.source)}`
    : `?origin=search&repo=${encodeURIComponent(origin.repo)}&path=${encodeURIComponent(origin.path)}`;

export async function listCatalogRequest(source = "anthropics"): Promise<CatalogList | { error: string }> {
  const res = await apiFetch<CatalogList>(`/api/settings/skills/catalog${source === "anthropics" ? "" : `?source=${encodeURIComponent(source)}`}`);
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `could not load the catalog (${res.status})` };
}

/** 0091 §1: federated search over SkillsMP. */
export async function searchCatalogRequest(query: string): Promise<CatalogSearch | { error: string }> {
  const res = await apiFetch<CatalogSearch>(`/api/settings/skills/catalog/search?q=${encodeURIComponent(query)}`);
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `search failed (${res.status})` };
}

export async function previewCatalogRequest(id: string, origin: SkillOrigin = DEFAULT_ORIGIN) {
  const res = await apiFetch<{ ok: true; skill: CatalogPreview } | { ok: false; message: string }>(
    `/api/settings/skills/catalog/${encodeURIComponent(id)}${originQuery(origin)}`,
  );
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `could not load the skill (${res.status})` };
}

export async function installCatalogRequest(id: string, origin: SkillOrigin = DEFAULT_ORIGIN): Promise<SkillMutationResult | { error: string }> {
  const res = await apiFetch<SkillMutationResult>(
    `/api/settings/skills/catalog/${encodeURIComponent(id)}`,
    jsonInit("POST", origin),
  );
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `install failed (${res.status})` };
}
