/**
 * 0034: ref-name rules every git-writing surface shares. The deny list
 * is app-side (belt); the enforcement that actually binds a sandbox is
 * the read-scoped credential (phase B) plus host branch protection
 * (phase C) — each layer assumes the previous one failed.
 */

/** Hard deny list — never pushable by any agent surface. */
const HARD_DENY = new Set(["main", "master", "develop"]);

/** A name safe to interpolate into a git command line (ref or dir). */
export function isSafeRefName(name: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/** May this head be pushed? `defaultBranch` is the checkout's
 *  origin/HEAD (best-effort, resolved by the caller). */
export function isProtectedRef(head: string, defaultBranch?: string | null): boolean {
  return HARD_DENY.has(head) || (!!defaultBranch && head === defaultBranch);
}
