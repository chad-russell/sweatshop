/**
 * 0090 §7 / 0091 §1: the curated public catalog sources — code, not
 * data. Each is a git repo of skill folders browsed with ONE git-trees
 * call. This module is CLIENT-safe (no db/store imports): the settings
 * UI renders the labels from here; lib/skills/catalog-source owns the
 * browsing machinery.
 */

export type CatalogSourceId = "anthropics" | "superpowers" | "openclaw";

/** 0091 §3: how many skills one send may attach. Client-safe here so
 * the composer's cap and the route's validation share one number. */
export const MAX_ATTACHED_SKILLS = 4;

export interface SourceDef {
  id: CatalogSourceId;
  owner: string;
  repo: string;
  /** The repo-relative folder holding the skill folders. */
  path: string;
  label: string;
}

export const SOURCES: readonly SourceDef[] = [
  { id: "anthropics", owner: "anthropics", repo: "skills", path: "skills", label: "anthropics/skills" },
  { id: "superpowers", owner: "obra", repo: "superpowers", path: "skills", label: "obra/superpowers" },
  { id: "openclaw", owner: "openclaw", repo: "openclaw", path: "skills", label: "openclaw/openclaw" },
];

export const sourceById = (id: string): SourceDef | undefined => SOURCES.find((s) => s.id === id);
