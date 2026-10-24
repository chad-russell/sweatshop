/**
 * 0039: the thread-skill catalog read (the fresh-target picker's
 * books). A null list means "not fetched yet"; any failure is an
 * empty catalog, as the picker's own catch arm was.
 */

import { apiFetch } from "./core";

export interface SkillOption {
  id: string;
  title: string;
  description: string;
}

/** The active skills the picker offers. Never throws; null on failure
 * (callers map that to an empty list). */
export async function listSkills(): Promise<SkillOption[] | null> {
  try {
    const res = await apiFetch<{ skills?: SkillOption[] }>("/api/skills", { cache: "no-store" });
    return res.ok ? (res.body?.skills ?? null) : null;
  } catch {
    return null;
  }
}
