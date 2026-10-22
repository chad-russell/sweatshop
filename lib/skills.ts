import type { TargetListItem } from "../db/prompt-settings";
import { renderOwnerPlaceholders } from "./agent/owner";
import { deriveSkillTitle } from "./skill-files";

/**
 * 0039/0054: skills — runbooks for a kind of work. A skill with
 * `thread: true` is a **thread skill**: bindable to a conversation as
 * that thread's way of working (the body joins the turn instructions
 * and raises the step budget, workflows/chat/turn.ts).
 *
 * 0054: the catalog moved from fs-only to DB-backed
 * (`db/prompt-settings.ts`), seeded lazily from `skills/<id>/SKILL.md`
 * on first read, editable from Settings and proposable by the agent
 * (approval-gated) from then on. This module's public functions keep
 * their exact names and return shapes from before 0054 — every call
 * site (workflows/chat/tools/core.ts, lib/agent/tools/start-thread.ts,
 * app/api/skills/route.ts, workflows/chat/mock-model.ts,
 * lib/tool-views/*) is unaffected by the storage change underneath.
 */

export interface Skill {
  id: string;
  /** Display text: owner placeholders (`{{owner}}`) are rendered at read time. */
  title: string;
  /** Display text: owner placeholders (`{{owner}}`) are rendered at read time. */
  description: string;
  /** A thread skill (front matter `thread: true`) can bind to a conversation. */
  thread: boolean;
  body: string;
  /** Catalog version the body was read from (0059 phase context). */
  version: number;
}

/** A thread's already-bound skill is looked up by id regardless of
 *  status — "disabled"/"deleted" only hide a skill from the catalog and
 *  from a NEW load (listSkills/listThreadSkills, use_skill, the creating
 *  send, or start_thread), never from a thread already running it.
 *  Unknown or
 *  malformed ids return null, same as a missing file did before 0054. */
export async function readSkill(id: string): Promise<Skill | null> {
  const [{ db }, store] = await Promise.all([import("../db"), import("../db/prompt-settings")]);
  const row = store.getTarget(db(), { kind: "skill", id });
  if (!row) return null;
  return {
    id,
    title: renderOwnerPlaceholders(deriveSkillTitle(row.body, id)),
    description: renderOwnerPlaceholders(row.description ?? ""),
    thread: row.thread ?? false,
    body: row.body,
    version: row.version,
  };
}

type SkillTarget = TargetListItem & { kind: "skill"; id: string };

function isSkillTarget(t: TargetListItem): t is SkillTarget {
  return t.kind === "skill";
}

function toSkill(row: SkillTarget): Skill {
  return {
    id: row.id,
    title: renderOwnerPlaceholders(deriveSkillTitle(row.body, row.id)),
    description: renderOwnerPlaceholders(row.description ?? ""),
    thread: row.thread ?? false,
    body: row.body,
    version: row.version,
  };
}

/** The general catalog: every skill that isn't tombstoned (deleted),
 *  active or disabled alike — sorted by id. */
export async function listSkills(): Promise<Skill[]> {
  const [{ db }, store] = await Promise.all([import("../db"), import("../db/prompt-settings")]);
  return store.listTargets(db(), { includeDeleted: false }).filter(isSkillTarget).map(toSkill);
}

/** Active skills of every kind — `use_skill` with no id. */
export async function listActiveSkills(): Promise<Skill[]> {
  const [{ db }, store] = await Promise.all([import("../db"), import("../db/prompt-settings")]);
  return store
    .listTargets(db(), { includeDeleted: false })
    .filter(isSkillTarget)
    .filter((row) => row.status === "active")
    .map(toSkill);
}

/** The bindable catalog: active thread skills only (pickers, start_thread). */
export async function listThreadSkills(): Promise<Skill[]> {
  const [{ db }, store] = await Promise.all([import("../db"), import("../db/prompt-settings")]);
  return store
    .listTargets(db(), { includeDeleted: false })
    .filter(isSkillTarget)
    .filter((row) => row.thread && row.status === "active")
    .map(toSkill);
}
