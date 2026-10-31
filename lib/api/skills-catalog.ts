/** 0090 §4/§5: the skills catalog's mutation endpoints. */

import { apiFetch, jsonInit } from "./core";

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
