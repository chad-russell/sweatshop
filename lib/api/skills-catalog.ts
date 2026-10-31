/** 0090 §4/§5: the skills catalog's mutation endpoints. */

import type { CatalogEntry, CatalogList } from "@/lib/skills/catalog-source";
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

// ---- 0090 §7: public catalog discovery ---------------------------------------

export interface CatalogPreview {
  id: string;
  raw: string;
  sha: string;
  files: { path: string; size: number }[];
}

const withSource = (source: string) => (source === "anthropics" ? "" : `?source=${encodeURIComponent(source)}`);

export async function listCatalogRequest(source = "anthropics"): Promise<CatalogList | { error: string }> {
  const res = await apiFetch<CatalogList>(`/api/settings/skills/catalog${withSource(source)}`);
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `could not load the catalog (${res.status})` };
}

export async function previewCatalogRequest(id: string, source = "anthropics") {
  const res = await apiFetch<{ ok: true; skill: CatalogPreview } | { ok: false; message: string }>(
    `/api/settings/skills/catalog/${encodeURIComponent(id)}${withSource(source)}`,
  );
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `could not load the skill (${res.status})` };
}

export async function installCatalogRequest(id: string, source = "anthropics"): Promise<SkillMutationResult | { error: string }> {
  const res = await apiFetch<SkillMutationResult>(
    `/api/settings/skills/catalog/${encodeURIComponent(id)}`,
    jsonInit("POST", { source }),
  );
  if (res.ok && res.body) return res.body;
  return { error: (res.body as { error?: string } | null)?.error ?? `install failed (${res.status})` };
}
