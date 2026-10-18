/**
 * Web + git-host query tools: web_fetch, web_search, docs, gh, forgejo. Split from the old single steps.ts - every function
 * keeps its "use step" directive; Node/sqlite imports stay lazy inside
 * each step body, and relative imports stay relative (the workflow
 * bundle has no "@/" alias).
 */

/** 1.5 (roadmap): fetch one web page — plain HTTP, capped, HTML stripped. */
export async function webFetchStep(url: string): Promise<unknown> {
  "use step";
  const { fetchWebPage } = await import("../../../lib/agent/tools/web");
  return fetchWebPage(url);
}

/** 1.5 (roadmap): search the web through Z.AI's coding-plan MCP tool. */
export async function webSearchStep(
  query: string,
  opts: { recency?: import("../../../lib/agent/tools/web-search").Recency; domain?: string },
): Promise<unknown> {
  "use step";
  const { searchWeb } = await import("../../../lib/agent/tools/web-search");
  return searchWeb(query, opts);
}

/** The agent's capability docs (docs/agent/*.md), read from the checkout. */
export async function systemDocsStep(topic?: string): Promise<unknown> {
  "use step";
  const { listDocTopics, readDoc } = await import("../../../lib/agent/tools/docs");
  if (topic === undefined || topic === "") return { ok: true, topics: await listDocTopics() };
  return readDoc(topic);
}

/** 0033: run one read-only gh command with the stored github credential. */
export async function ghStep(args: string[]): Promise<unknown> {
  "use step";
  const { runGh } = await import("../../../lib/agent/tools/gh");
  return runGh(args);
}

/** 0033 A′: one read-only forgejo API GET on the stored credential. */
export async function forgejoStep(path: string, params: Record<string, string>): Promise<unknown> {
  "use step";
  const { runForgejo } = await import("../../../lib/agent/tools/forgejo");
  return runForgejo(path, params);
}
