import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { previewSetups, projectRepos } from "./schema";
import type { Db } from "./index";
import {
  parsePreviewSetup,
  parsePreviewSetupJson,
  type PreviewSetupDefinition,
} from "@/lib/previews/setup";

/**
 * 0017 preview setup store: one row per project, the definition JSON
 * validated on both write and read (machines pattern; setups are
 * user/agent-editable, so a bad row surfaces as a value, not a throw).
 */

export interface PreviewSetup {
  id: string;
  projectId: string;
  definition: PreviewSetupDefinition;
  createdAt: number;
  updatedAt: number;
}

export type SetupResult<T> = { ok: true; setup: T } | { ok: false; issues: string[] };

export function getPreviewSetup(db: Db, projectId: string): SetupResult<PreviewSetup | null> {
  const row = db.select().from(previewSetups).where(eq(previewSetups.projectId, projectId)).get();
  if (!row) return { ok: true, setup: null };
  const parsed = parsePreviewSetupJson(row.definition);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  return {
    ok: true,
    setup: { ...row, definition: parsed.definition },
  };
}

/** The parsed definition alone (the hot path — create/launch/tools). */
export function getPreviewSetupDefinition(
  db: Db,
  projectId: string | null,
): PreviewSetupDefinition | null {
  if (!projectId) return null;
  const result = getPreviewSetup(db, projectId);
  return result.ok ? result.setup?.definition ?? null : null;
}

/** Upsert the project's setup; `definition` is raw input, validated
 *  here — including that its `repo` belongs to the project. */
export function savePreviewSetup(
  db: Db,
  projectId: string,
  definition: unknown,
): SetupResult<PreviewSetup> {
  const parsed = parsePreviewSetup(definition);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const repo = db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(eq(projectRepos.id, parsed.definition.repo))
    .get();
  if (!repo) {
    return { ok: false, issues: [`repo: ${parsed.definition.repo} does not exist — add it to the project first`] };
  }
  const belongs = db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, projectId))
    .all()
    .some((r) => r.id === parsed.definition.repo);
  if (!belongs) {
    return { ok: false, issues: [`repo: ${parsed.definition.repo} is not in project ${projectId}`] };
  }
  const now = Date.now();
  const existing = db
    .select({ id: previewSetups.id })
    .from(previewSetups)
    .where(eq(previewSetups.projectId, projectId))
    .get();
  const row = {
    id: existing?.id ?? `psu_${nanoid()}`,
    projectId,
    definition: JSON.stringify(parsed.definition),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(previewSetups)
    .values(row)
    .onConflictDoUpdate({
      target: previewSetups.projectId,
      set: { definition: row.definition, updatedAt: row.updatedAt },
    })
    .run();
  return { ok: true, setup: { ...row, definition: parsed.definition } };
}

/** Drop the project's setup (a fresh Discover starts over). */
export function deletePreviewSetup(db: Db, projectId: string): boolean {
  const deleted = db.delete(previewSetups).where(eq(previewSetups.projectId, projectId)).run();
  return deleted.changes > 0;
}
