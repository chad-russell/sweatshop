/**
 * PR dashboard view shapes (0053) — the loader (lib/prs/dashboard) fills
 * them live from the git hosts on every page load; nothing is stored
 * (0049: components draw these, never @/db).
 */
import type { PRSummary } from "../git-hosts";

/** One PR as the dashboard draws it (a host's summary, verbatim). */
export type DashboardPR = PRSummary;

/** A repo the dashboard could not ask — rendered as a note, never fatal. */
export interface FailedRepo {
  /** The project_repos row id (`<projectId>/<name>`). */
  repo: string;
  reason: string;
}

export interface PRDashboardData {
  /** Open first (needs-attention order), then settled (merged, closed). */
  prs: DashboardPR[];
  /** Repos the hosts answered. */
  reposQueried: number;
  failedRepos: FailedRepo[];
}
