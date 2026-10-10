import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { harnessEvents } from "@/db/schema";
import { listStageRuns } from "@/db/machines";

/**
 * 2026-10-09 (run 3 post-mortem): the screenshots a run's harness visits
 * attached, keyed by stage seq — the visual evidence stage briefs cite
 * and the PR gate renders, so the judgment happens where the eyes are.
 * Plain and db-level: the workflow's loadEvidence step and the inbox's
 * gate card both call it.
 */

export interface RunEvidence {
  label?: string;
  url: string;
}

export function collectRunEvidence(runId: string): Record<number, RunEvidence[]> {
  const out: Record<number, RunEvidence[]> = {};
  for (const v of listStageRuns(db(), runId)) {
    if (!v.sessionId || v.kind !== "harness") continue;
    const rows = db()
      .select({ output: harnessEvents.output })
      .from(harnessEvents)
      .where(
        and(
          eq(harnessEvents.sessionId, v.sessionId),
          eq(harnessEvents.kind, "tool-end"),
          eq(harnessEvents.toolName, "attach_screenshot"),
        ),
      )
      .all();
    const found: RunEvidence[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.output ?? "") as { ok?: boolean; url?: string };
        if (parsed.ok === true && parsed.url) found.push({ url: parsed.url });
      } catch {
        // clipped or non-JSON output — skip
      }
    }
    if (found.length > 0) out[v.seq] = found;
  }
  return out;
}
