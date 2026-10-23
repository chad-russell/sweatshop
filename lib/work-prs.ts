/**
 * 0078: one PR per create_pr call, many calls per thread — the work
 * pill's source. Pure (no db) and client-safe (the only cross-file type
 * pulled in, `PRStateInfo`, is a type-only import that erases at
 * compile time) so both the server context (lib/chat-ui.ts) and the
 * client (components/work-pill.tsx) derive from the same transcript walk.
 */

import type { UIMessage } from "ai";
import { DIFF_CATEGORY_ORDER, isDiffBreakdown, type DiffBreakdown, type DiffBreakdownCategory } from "./diff-breakdown";
import type { PRStateInfo } from "./use-pr-states";

export interface WorkPR {
  toolCallId: string;
  url?: string;
  number?: number;
  /** The local repo directory name from the tool's input — NOT
   *  "owner/repo" (see `prUrlCoords` for the host-facing form). */
  repo?: string;
  title?: string;
  head?: string;
  state: "pending" | "open";
  breakdown?: DiffBreakdown;
}

type LoosePart = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown };

function prInputFields(part: LoosePart): { title?: string; head?: string; repo?: string } {
  const input = part.input as { title?: unknown; head?: unknown; repo?: unknown } | undefined;
  return {
    title: typeof input?.title === "string" ? input.title : undefined,
    head: typeof input?.head === "string" ? input.head : undefined,
    repo: typeof input?.repo === "string" ? input.repo : undefined,
  };
}

/**
 * Every create_pr call in transcript order: pending while awaiting
 * approval, open once it succeeds, dropped entirely once denied/sent
 * back (`ok: false`) or errored. Multiple calls that land the same PR
 * (a retried open) dedupe by url — the newest result wins, keeping the
 * first call's position in the list.
 */
export function workPRsFromMessages(messages: readonly UIMessage[]): WorkPR[] {
  const byCall = new Map<string, WorkPR>();
  const callOrder: string[] = [];
  for (const message of messages) {
    for (const raw of message.parts) {
      const part = raw as LoosePart;
      if (part.type !== "tool-create_pr" || !part.toolCallId) continue;
      const { toolCallId } = part;
      if (part.state === "input-available" || part.state === "input-streaming") {
        if (!byCall.has(toolCallId)) callOrder.push(toolCallId);
        byCall.set(toolCallId, { ...prInputFields(part), toolCallId, state: "pending" });
      } else if (part.state === "output-available") {
        const output = part.output as { ok?: unknown; url?: unknown; number?: unknown; breakdown?: unknown } | undefined;
        if (output?.ok === false) {
          byCall.delete(toolCallId);
          continue;
        }
        if (!byCall.has(toolCallId)) callOrder.push(toolCallId);
        byCall.set(toolCallId, {
          ...prInputFields(part),
          toolCallId,
          state: "open",
          url: typeof output?.url === "string" ? output.url : undefined,
          number: typeof output?.number === "number" ? output.number : undefined,
          breakdown: isDiffBreakdown(output?.breakdown) ? output.breakdown : undefined,
        });
      } else if (part.state === "output-error") {
        byCall.delete(toolCallId);
      }
    }
  }
  const ordered = callOrder.map((id) => byCall.get(id)).filter((pr): pr is WorkPR => pr !== undefined);

  // Dedupe by url, newest wins, first-seen position kept.
  const positionByUrl = new Map<string, number>();
  const deduped: WorkPR[] = [];
  for (const pr of ordered) {
    const existing = pr.url ? positionByUrl.get(pr.url) : undefined;
    if (existing !== undefined) {
      deduped[existing] = pr;
    } else {
      if (pr.url) positionByUrl.set(pr.url, deduped.length);
      deduped.push(pr);
    }
  }
  return deduped;
}

/** Sum breakdowns across PRs into one aggregate table, categories in the
 *  same fixed order as a single PR's (`DIFF_CATEGORY_ORDER`). */
export function mergeBreakdowns(list: readonly DiffBreakdown[]): DiffBreakdown | null {
  if (list.length === 0) return null;
  const byKey = new Map<string, DiffBreakdownCategory>();
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const breakdown of list) {
    files += breakdown.files;
    added += breakdown.added;
    deleted += breakdown.deleted;
    for (const category of breakdown.categories) {
      const existing = byKey.get(category.key);
      if (existing) {
        existing.files += category.files;
        existing.added += category.added;
        existing.deleted += category.deleted;
      } else {
        byKey.set(category.key, { ...category });
      }
    }
  }
  const categories = DIFF_CATEGORY_ORDER.map((key) => byKey.get(key)).filter(
    (c): c is DiffBreakdownCategory => c !== undefined,
  );
  return { files, added, deleted, categories };
}

export type WorkPRDisplayState = "pending" | "open" | "merged" | "closed";

export interface DisplayWorkPR extends WorkPR {
  displayState: WorkPRDisplayState;
}

/** Overlay the host's live answer (0052) onto each open PR; a pending
 *  PR has no live state to ask for yet. */
export function applyLiveStates(
  prs: readonly WorkPR[],
  states: Record<string, PRStateInfo | null | undefined>,
): DisplayWorkPR[] {
  return prs.map((pr) => {
    if (pr.state === "pending") return { ...pr, displayState: "pending" };
    const live = pr.url ? states[pr.url] : null;
    return { ...pr, displayState: live?.state ?? "open" };
  });
}

/** owner/repo + number read off a PR web URL — the host-facing form,
 *  distinct from `WorkPR.repo` (the local repo directory name). */
export function prUrlCoords(url: string): { repo: string; number: string } | null {
  const match = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/);
  return match ? { repo: `${match[1]}/${match[2]}`, number: match[3] } : null;
}
