import { and, eq } from "drizzle-orm";
import type { Db } from "./index";
import { projectHosts, type ProjectHost } from "./schema";

/**
 * 0043: the per-project host allow-list. All value-shaped; the app holds
 * no credentials for a host — those resolve from env at call time
 * (lib/hosts/credentials.ts), keyed by the host NAME. The audit rows
 * live in db/host-commands.ts; this file is the registry.
 */

export type HostResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

const fail = (code: string, message: string) => ({ ok: false as const, code, message });

const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Parse `host` or `host:port` into a connect shape (ssh2's terms). */
export function parseAddress(address: string): { host: string; port: number } | null {
  const trimmed = address.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 255) return null;
  // A bracketed literal may carry a port: `[::1]:2222`. Unbracketed
  // IPv6 contains colons and is passed through whole (default port).
  const bracket = trimmed.match(/^\[(.+)\](?::(\d+))?$/);
  if (bracket) {
    const port = bracket[2] ? Number(bracket[2]) : 22;
    return port >= 1 && port <= 65535 ? { host: bracket[1]!, port } : null;
  }
  const colon = trimmed.match(/^(.+):(\d+)$/);
  if (colon && !colon[1]!.includes(":")) {
    const port = Number(colon[2]);
    return port >= 1 && port <= 65535 ? { host: colon[1]!, port } : null;
  }
  return { host: trimmed, port: 22 };
}

/** What the project page and the tool description see. */
export function listProjectHosts(db: Db, projectId: string): ProjectHost[] {
  return db
    .select()
    .from(projectHosts)
    .where(eq(projectHosts.projectId, projectId))
    .orderBy(projectHosts.name)
    .all();
}

export function getProjectHostByName(db: Db, projectId: string, name: string): ProjectHost | null {
  return (
    db
      .select()
      .from(projectHosts)
      .where(and(eq(projectHosts.projectId, projectId), eq(projectHosts.name, name)))
      .get() ?? null
  );
}

export function addProjectHost(
  db: Db,
  projectId: string,
  input: { name: string; address: string; user: string; apiBase?: string | null },
): HostResult<{ host: ProjectHost }> {
  const name = input.name.trim().toLowerCase();
  if (!HOST_NAME.test(name)) {
    return fail("invalid-name", "Host name must be lowercase kebab — it also names the credential env vars.");
  }
  const address = input.address.trim();
  if (!parseAddress(address)) return fail("invalid-address", "Address must be `host` or `host:port`.");
  const user = input.user.trim();
  if (!user || user.length > 64) return fail("invalid-user", "A remote user is required.");
  const apiBase = input.apiBase?.trim() ? input.apiBase.trim() : null;
  if (apiBase !== null && !/^https?:\/\/\S+$/i.test(apiBase)) {
    return fail("invalid-api-base", "api_base must be an absolute http(s) URL (informational only).");
  }
  const dup = db
    .select({ id: projectHosts.id })
    .from(projectHosts)
    .where(and(eq(projectHosts.projectId, projectId), eq(projectHosts.name, name)))
    .get();
  if (dup) return fail("conflict", `Host "${name}" already exists on this project.`);
  const host: ProjectHost = {
    id: `ph_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    projectId,
    name,
    address,
    user,
    apiBase,
    hostKeyFp: null,
    createdAt: Date.now(),
  };
  db.insert(projectHosts).values(host).run();
  return { ok: true, host };
}

/** Removing a host deletes nothing historical — audit rows survive it. */
export function removeProjectHost(db: Db, projectId: string, hostId: string): HostResult<{ removed: true }> {
  const row = db
    .select({ id: projectHosts.id })
    .from(projectHosts)
    .where(and(eq(projectHosts.projectId, projectId), eq(projectHosts.id, hostId)))
    .get();
  if (!row) return fail("not-found", "No such host on this project.");
  db.delete(projectHosts).where(eq(projectHosts.id, hostId)).run();
  return { ok: true, removed: true };
}

/** 0043 TOFU: pin the fingerprint seen on the first successful connect. */
export function setHostKeyFingerprint(db: Db, hostId: string, fingerprint: string): void {
  db.update(projectHosts).set({ hostKeyFp: fingerprint }).where(eq(projectHosts.id, hostId)).run();
}

