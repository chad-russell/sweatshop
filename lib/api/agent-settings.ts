/**
 * 0054: the /settings agent screen's client — the prompt sections and
 * the skill catalog's admin surface. Unlike the ApiResult modules this
 * endpoint family carries its own contract: every failure body is
 * `{ok:false, code?, issues?, current?}` and a 409 (optimistic-version
 * conflict) is a RESULT, not an error — the screen shows the server's
 * current row for review instead of throwing.
 */

/** What can be edited: one of the three prompt sections, or a skill. */
export type AgentTarget = { kind: "section"; key: "base" | "harness_steering" | "host_routing" } | { kind: "skill"; id: string };

/** One stored version of a section/skill body plus its row metadata. */
export interface Row {
  body: string;
  version: number;
  origin?: string;
  description?: string;
  thread?: boolean;
  status?: "active" | "disabled" | "deleted";
  editedBy?: string;
  note?: string | null;
  updatedAt?: number;
  createdAt?: number;
}

/** The list view's row: metadata plus which target it belongs to. */
export type ListedTarget = Row & AgentTarget;

/** The shipped (Git) default of a target — what Reset returns to. */
export type AgentDefault = { body: string; description?: string; thread?: boolean; status?: Row["status"] };

/** A PUT's outcome. `ok` covers publish/reset/restore; a conflict
 * carries the server's current row so the screen can diff against it. */
export interface AgentPutResult {
  ok: boolean;
  code?: string;
  issues?: string[];
  current?: Row | null;
  version?: number;
}

/** `?kind=section&key=…` / `?kind=skill&id=…` — the target's params. */
function params(target: AgentTarget): string {
  return `kind=${target.kind}&${target.kind === "section" ? `key=${target.key}` : `id=${encodeURIComponent(target.id)}`}`;
}

const ENDPOINT = "/api/settings/agent";

/**
 * The surface's shared request: always no-store; the body is parsed
 * even on failure; !ok THROWS (issues joined, else the error string)
 * EXCEPT 409, whose conflict body is returned for the caller's
 * conflict handling. Network errors reject, as before.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok && res.status !== 409) {
    const issues = Array.isArray(data.issues) ? (data.issues as string[]).join("; ") : undefined;
    const error = typeof data.error === "string" ? data.error : undefined;
    throw new Error(issues ?? error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** The list of editable targets (skills optionally including deleted). */
export function listAgentTargets(includeDeleted: boolean): Promise<{ targets: ListedTarget[] }> {
  return request(`${ENDPOINT}?includeDeleted=${includeDeleted}`);
}

/** A target's shipped default (404 "No shipped default" throws). */
export function getAgentDefault(target: AgentTarget): Promise<AgentDefault> {
  return request(`${ENDPOINT}?action=default&${params(target)}`);
}

/** A target's current row and its full version history. */
export function getAgentDetail(target: AgentTarget): Promise<{ current: Row | null; versions: Row[] }> {
  return request(`${ENDPOINT}?action=detail&${params(target)}`);
}

/** The assembled prompt as it stands (no draft override). */
export function getAssembledPrompt(): Promise<{ prompt: string }> {
  return request(`${ENDPOINT}?action=preview`);
}

/** The assembled prompt with a section's draft body swapped in. */
export function previewSectionDraft(key: "base" | "harness_steering" | "host_routing", body: string): Promise<{ prompt: string }> {
  return request(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "preview", target: { kind: "section", key }, body }),
  });
}

/**
 * Publish/reset/restore a target. `expectedVersion` is the optimistic
 * concurrency token; a mismatch is the 409 result described above.
 */
export function putAgentTarget(input: {
  target: AgentTarget;
  expectedVersion: number;
  action: "publish" | "reset" | "restore";
  patch?: object;
  version?: number;
}): Promise<AgentPutResult> {
  return request(ENDPOINT, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
