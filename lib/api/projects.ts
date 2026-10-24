/**
 * Project writes from the project page's editors (name/image/test
 * command, repos, hosts, models) and the New-project flow, plus the
 * New-preview flow's repo/branch listing. The editors share the
 * page's `useApi` helper, so these return the raw ApiResult and the
 * helper formats errors once at the surface.
 */

import { apiFetch, jsonInit, type ApiResult } from "./core";

/** A project repo row as the branches endpoint reports it (the
 * project page's editor rows carry `host` too — server props). */
export interface ProjectRepo {
  id: string;
  name: string;
  url: string;
}

/**
 * Create a project (New-project modal). `{id}` on success; on failure
 * the endpoint's `{error}` or the status fallback. Network errors
 * reject, as the modal's submit did.
 */
export async function createProject(input: {
  id: string;
  name: string;
  repos: { name: string; url: string }[];
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const res = await apiFetch<{ error?: string; project?: { id: string } }>("/api/projects", jsonInit("POST", input));
  if (res.ok && res.body?.project) return { ok: true, id: res.body.project.id };
  return { ok: false, error: (res.body as { error?: string } | null)?.error ?? `failed (${res.status})` };
}

/** PATCH a project's editable columns (name, image, testCommand,
 * testCommandPrefix — a partial `{}`). */
export async function updateProject(projectId: string, patch: Record<string, unknown>): Promise<ApiResult> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, jsonInit("PATCH", patch));
}

export async function deleteProject(projectId: string): Promise<ApiResult> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
}

export async function addProjectRepo(
  projectId: string,
  repo: { name: string; url: string },
): Promise<ApiResult> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}/repos`, jsonInit("POST", repo));
}

export async function removeProjectRepo(projectId: string, repoId: string): Promise<ApiResult> {
  return apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/repos?repoId=${encodeURIComponent(repoId)}`,
    { method: "DELETE" },
  );
}

export async function addProjectHost(
  projectId: string,
  host: { name: string; address: string; user: string; apiBase?: string },
): Promise<ApiResult> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}/hosts`, jsonInit("POST", host));
}

export async function removeProjectHost(projectId: string, hostId: string): Promise<ApiResult> {
  return apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/hosts?hostId=${encodeURIComponent(hostId)}`,
    { method: "DELETE" },
  );
}

/** The Models card's allow-list PATCH (defaultRoute + restrictions). */
export async function patchProjectModels(projectId: string, body: Record<string, unknown>): Promise<ApiResult> {
  return apiFetch(`/api/projects/${encodeURIComponent(projectId)}/models`, jsonInit("PATCH", body));
}

/**
 * 0017: a project's repos. Never throws and never returns null: any
 * failure is an empty list, as the flow's own
 * `.catch(() => ({ repos: [] }))` was.
 */
export async function getProjectRepos(projectId: string): Promise<ProjectRepo[]> {
  try {
    const res = await apiFetch<{ repos?: ProjectRepo[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/branches`,
      { cache: "no-store" },
    );
    return res.body?.repos ?? [];
  } catch {
    return [];
  }
}

/**
 * 0017: one repo's remote branches (`?repo=`), with the listing's
 * `warning` when the host could not be asked (the form falls back to a
 * typed branch name). Never throws; a failure is an empty list and no
 * warning, as the flow's own catch arm was.
 */
export async function getRemoteBranches(
  projectId: string,
  repoId: string,
): Promise<{ branches: string[]; warning: string | null }> {
  try {
    const res = await apiFetch<{ branches?: string[]; warning?: string | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/branches?repo=${encodeURIComponent(repoId)}`,
      { cache: "no-store" },
    );
    return { branches: res.body?.branches ?? [], warning: res.body?.warning ?? null };
  } catch {
    return { branches: [], warning: null };
  }
}
