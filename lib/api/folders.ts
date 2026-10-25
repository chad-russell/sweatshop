/**
 * 0007: the sidebar's folder tree mutations. Raw results — the actions
 * hook decides between mirroring the endpoint's error string and
 * refreshing the layout; network errors reject for its catch.
 */

import { apiFetch, jsonInit, type ApiResult } from "./core";

/** Create a folder under a parent (null = top level). */
export function createFolder(name: string, projectId: string | null, parentId: string | null): Promise<ApiResult> {
  return apiFetch("/api/folders", jsonInit("POST", { name, projectId, parentId }));
}

/** PATCH a folder row (rename via `name`, move via `parentId`). */
export function updateFolder(id: string, patch: Record<string, unknown>): Promise<ApiResult> {
  return apiFetch(`/api/folders/${encodeURIComponent(id)}`, jsonInit("PATCH", patch));
}

/** Delete a folder (the server checks it is empty). */
export function deleteFolder(id: string): Promise<ApiResult> {
  return apiFetch(`/api/folders/${encodeURIComponent(id)}`, { method: "DELETE" });
}
