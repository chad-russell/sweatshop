import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./index";

/** Structural surfaces the store needs (attention reads with a Conn). */
type SelectDb = Pick<Db, "select">;
type WriteDb = Pick<Db, "select" | "insert" | "update">;
import { prProposals } from "./schema";

/**
 * 0034 Phase A: run-scoped PR proposals (see the schema comment). A
 * stage visit's propose_pr records here; the run's human gate card
 * shows the pending one; the publish stage resolves it with the
 * outcome. The latest unresolved row wins — a fix-loop re-propose
 * supersedes without touching earlier (already-resolved) rows.
 */

export interface PRProposalRow {
  id: string;
  runId: string;
  projectId: string;
  repo: string;
  head: string;
  base: string | null;
  title: string;
  body: string | null;
  summary: string;
  status: string;
  resultUrl: string | null;
  resultNumber: number | null;
  error: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface NewPRProposal {
  id: string;
  runId: string;
  projectId: string;
  repo: string;
  head: string;
  base?: string | null;
  title: string;
  body?: string | null;
  summary: string;
}

export function getPRProposal(db: SelectDb, id: string): PRProposalRow | null {
  return db.select().from(prProposals).where(eq(prProposals.id, id)).get() ?? null;
}

/** Insert unless the id exists already (step retries must not duplicate). */
export function recordPRProposal(db: WriteDb, proposal: NewPRProposal): PRProposalRow {
  const existing = getPRProposal(db, proposal.id);
  if (existing) return existing;
  db.insert(prProposals)
    .values({ ...proposal, status: "pending", createdAt: Date.now() })
    .run();
  return getPRProposal(db, proposal.id)!;
}

/** The run's pending proposal — what the gate shows and publish opens.
 *  Newest unresolved wins (a re-propose after a fix loop supersedes);
 *  insertion order breaks same-millisecond ties. */
export function pendingRunProposal(db: SelectDb, runId: string): PRProposalRow | null {
  const rows = db
    .select()
    .from(prProposals)
    .where(and(eq(prProposals.runId, runId), isNull(prProposals.resolvedAt)))
    .all();
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

export type PRProposalOutcome =
  | { status: "opened"; url: string; number: number }
  | { status: "denied"; comment?: string }
  | { status: "failed"; error: string };

/** Settle a proposal (pending rows only — the first final write wins). */
export function resolvePRProposal(db: WriteDb, id: string, outcome: PRProposalOutcome): boolean {
  const result = db
    .update(prProposals)
    .set({
      status: outcome.status,
      resultUrl: outcome.status === "opened" ? outcome.url : null,
      resultNumber: outcome.status === "opened" ? outcome.number : null,
      error:
        outcome.status === "failed"
          ? outcome.error
          : outcome.status === "denied"
            ? (outcome.comment ?? null)
            : null,
      resolvedAt: Date.now(),
    })
    .where(and(eq(prProposals.id, id), isNull(prProposals.resolvedAt)))
    .run();
  return result.changes > 0;
}
