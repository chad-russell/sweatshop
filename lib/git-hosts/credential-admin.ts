import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { gitCredentials } from "@/db/schema";

/**
 * The settings page's view of `git_credentials`. The secret never
 * leaves the server whole: rows carry a short `hint` (start and end of
 * the token) so you can tell which token is stored without exposing it.
 */
export interface GitCredentialView {
  id: string;
  kind: "github" | "forgejo";
  label: string;
  username: string;
  baseUrl: string | null;
  hint: string;
}

export function secretHint(secret: string): string {
  if (secret.length <= 12) return "•".repeat(secret.length);
  return `${secret.slice(0, 8)}…${secret.slice(-4)}`;
}

export function listGitCredentialViews(db: Db): GitCredentialView[] {
  return db
    .select()
    .from(gitCredentials)
    .all()
    .map((c) => ({
      id: c.id,
      kind: c.kind === "forgejo" ? "forgejo" : "github",
      label: c.label,
      username: c.username,
      baseUrl: c.baseUrl,
      hint: secretHint(c.secret),
    }));
}

export type CredentialWrite = { ok: true } | { ok: false; status: number; error: string };

/** Replace one credential's token (and optionally its username). Takes
 *  effect for newly provisioned sandboxes; existing ones keep the old
 *  `.git-credentials` line until re-provisioned. */
export function updateGitCredential(db: Db, id: unknown, secret: unknown, username?: unknown): CredentialWrite {
  if (typeof id !== "string" || typeof secret !== "string" || !secret.trim()) {
    return { ok: false, status: 400, error: "id and a non-empty secret are required" };
  }
  if (username !== undefined && (typeof username !== "string" || !username.trim())) {
    return { ok: false, status: 400, error: "username must be a non-empty string" };
  }
  const patch: { secret: string; username?: string } = { secret: secret.trim() };
  if (typeof username === "string") patch.username = username.trim();
  const res = db.update(gitCredentials).set(patch).where(eq(gitCredentials.id, id)).run();
  return res.changes === 0 ? { ok: false, status: 404, error: "no such credential" } : { ok: true };
}

/** Add a credential. forgejo needs a base URL; github must not have one. */
export function createGitCredential(
  db: Db,
  input: { kind?: unknown; username?: unknown; secret?: unknown; label?: unknown; baseUrl?: unknown },
): CredentialWrite {
  const { kind, username, secret, label, baseUrl } = input;
  if (kind !== "github" && kind !== "forgejo") return { ok: false, status: 400, error: "kind must be github or forgejo" };
  if (typeof username !== "string" || !username.trim() || typeof secret !== "string" || !secret.trim()) {
    return { ok: false, status: 400, error: "username and secret are required" };
  }
  if (kind === "forgejo" && (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl))) {
    return { ok: false, status: 400, error: "forgejo needs a base URL (https://…)" };
  }
  const user = username.trim();
  const id = `${kind}-${user.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (db.select().from(gitCredentials).where(eq(gitCredentials.id, id)).get()) {
    return { ok: false, status: 409, error: `${id} already exists — edit its token instead` };
  }
  db.insert(gitCredentials)
    .values({
      id,
      kind,
      label: typeof label === "string" && label.trim() ? label.trim() : kind === "github" ? `GitHub (${user})` : `Forgejo (${user})`,
      username: user,
      secret: secret.trim(),
      baseUrl: kind === "forgejo" ? (baseUrl as string) : null,
      createdAt: Date.now(),
    })
    .run();
  return { ok: true };
}
