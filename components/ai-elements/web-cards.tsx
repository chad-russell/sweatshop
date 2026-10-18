"use client";

import { ChevronDownIcon, GlobeIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { Card, Pill, failureLines, statePill } from "@/components/ai-elements/agent-cards";
import {
  fetchView,
  formatBytes,
  searchView,
  urlHeadline,
  webFailureOf,
  webState,
} from "@/lib/tool-views/web";
import { cn } from "@/lib/utils";

/**
 * 1.5 (roadmap): the designed cards for web_search and web_fetch —
 * built on the agent-cards shell (icon + headline + pill, body behind
 * the chevron). Search shows its hits as a compact linked list; fetch
 * shows the page headline plus the stripped text it returned.
 */

export function WebSearchCard({
  state,
  input,
  output,
  errorText,
}: {
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const failed = webFailureOf(output) !== undefined || state === "output-error";
  const toolState = webState({ state }, failed);
  const view = searchView(input, output);
  const { tone, pill } = statePill(toolState, failed);
  return (
    <Card
      icon={SearchIcon}
      title="Search"
      subtitle={view?.query}
      tone={tone}
      pill={failed ? "failed" : toolState === "running" ? "running" : view ? `${view.hits.length} results` : "done"}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      className="my-1"
    >
      {view && view.hits.length > 0 && (
        <ul className="divide-y divide-border">
          {view.hits.map((hit, i) => (
            <li key={i} className="px-3 py-2">
              <div className="flex min-w-0 items-baseline gap-2">
                {hit.url ? (
                  <a
                    href={hit.url}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate text-[12.5px] font-medium underline decoration-border underline-offset-2 hover:decoration-foreground"
                  >
                    {hit.title}
                  </a>
                ) : (
                  <span className="min-w-0 truncate text-[12.5px] font-medium">{hit.title}</span>
                )}
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{hostOf(hit.url)}</span>
              </div>
              {hit.snippet && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{hit.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
      {view && view.hits.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">No results.</p>
      )}
    </Card>
  );
}

export function WebFetchCard({
  state,
  input,
  output,
  errorText,
}: {
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const failed = webFailureOf(output) !== undefined || state === "output-error";
  const toolState = webState({ state }, failed);
  const view = fetchView(input, output);
  const { tone, pill } = statePill(toolState, failed);
  const okPill =
    toolState === "running" ? "running" : view?.status ? `${view.status}${view.bytes ? ` · ${formatBytes(view.bytes)}` : ""}` : "done";
  return (
    <Card
      icon={GlobeIcon}
      title="Fetch"
      subtitle={view ? urlHeadline(view.finalUrl ?? view.url) : undefined}
      tone={tone}
      pill={failed ? "failed" : okPill}
      failed={failed}
      errorLines={failureLines(output, errorText)}
      link={view?.url ? { href: view.url, label: "Open" } : undefined}
      className="my-1"
    >
      {view && (
        <div className="px-3 py-2">
          {view.title && <p className="truncate text-[12.5px] font-medium">{view.title}</p>}
          <p className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted-foreground">
            {view.contentType && <span>{view.contentType}</span>}
            {(view.truncated || view.textClipped) && <span className="text-warning">capped</span>}
          </p>
          {view.text && (
            <div className="mt-1.5 max-h-48 overflow-y-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
              {view.text.slice(0, 4_000)}
              {view.text.length > 4_000 ? "…" : ""}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
