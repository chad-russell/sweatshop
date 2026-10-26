/** The settings page's git-credential endpoints (secrets arrive as hints only). */

import type { GitCredentialView } from "@/lib/git-hosts/credential-admin";
import { apiError, apiFetch, jsonInit } from "./core";

export type { GitCredentialView };

type Result = { credentials: GitCredentialView[] } | { error: string };

export async function listGitCredentials(): Promise<Result> {
  const res = await apiFetch<{ credentials: GitCredentialView[] }>("/api/settings/git-credentials");
  return res.ok && res.body ? res.body : { error: apiError(res, "could not load credentials") };
}

export async function updateGitCredentialSecret(id: string, secret: string): Promise<Result> {
  const res = await apiFetch<{ credentials: GitCredentialView[] }>(
    "/api/settings/git-credentials",
    jsonInit("PUT", { id, secret }),
  );
  return res.ok && res.body ? res.body : { error: apiError(res, "save failed") };
}

export async function addGitCredential(input: {
  kind: "github" | "forgejo";
  username: string;
  secret: string;
  baseUrl?: string;
}): Promise<Result> {
  const res = await apiFetch<{ credentials: GitCredentialView[] }>(
    "/api/settings/git-credentials",
    jsonInit("POST", input),
  );
  return res.ok && res.body ? res.body : { error: apiError(res, "save failed") };
}
