import type { Recency } from "../web-search";

const RECENCY_HINT: Partial<Record<Recency, string>> = {
  oneDay: "Only use sources published in the last day.",
  oneWeek: "Only use sources published in the last week.",
  oneMonth: "Only use sources published in the last month.",
  oneYear: "Only use sources published in the last year.",
};

/** The prompt line for a recency filter (LLM-backed providers have no native one). */
export function recencyHint(recency: Recency | undefined): string {
  return recency ? (RECENCY_HINT[recency] ?? "") : "";
}
