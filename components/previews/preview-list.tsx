"use client";

import Link from "next/link";
import { ExternalLink, FileText, RotateCw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { shortSandboxId } from "@/lib/sandbox-id";
import type { PreviewView } from "@/lib/previews/service";
import { cn } from "@/lib/utils";
import {
  PREVIEW_TONE,
  PreviewDot,
  PreviewLogDialog,
  previewAction,
  previewName,
  usePreviews,
} from "./preview-pill";

/** A starter id's page: runs (mr_…, not a stage visit) open the run view. */
function startedByHref(id: string): string {
  return /^mr_[^_]+$/.test(id) ? `/r/${id}` : `/c/${id}`;
}

/**
 * 0016: previews as rows with their actions — the sandbox page's
 * Previews section (`query = sandbox=<id>`) and the /previews list (no
 * filter). Live: polled like the header pill.
 */
export function PreviewList({
  query,
  showSandbox = false,
  empty,
  highlight,
}: {
  query: string;
  showSandbox?: boolean;
  empty: string;
  highlight?: string;
}) {
  const { previews, refresh } = usePreviews(query);
  const [logsFor, setLogsFor] = useState<PreviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (p: PreviewView, action: "restart" | "stop" | "delete") => {
    if (
      action === "delete" &&
      !confirm(
        p.source === "branch"
          ? `Delete preview ${previewName(p)}? Its dedicated sandbox is destroyed too.`
          : `Delete preview ${previewName(p)}? The server stops; the sandbox stays with its chat.`,
      )
    ) {
      return;
    }
    setBusy(p.id);
    const error = await previewAction(p.id, action);
    setBusy(null);
    if (error) alert(error);
    await refresh();
  };

  if (previews.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;

  return (
    <>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {previews.map((p) => (
          <li
            key={p.id}
            id={p.id}
            className={cn("flex flex-col gap-1.5 px-3 py-2.5 text-sm", highlight === p.id && "bg-accent/50")}
          >
            <div className="flex items-center gap-2">
              <PreviewDot status={p.status} />
              <span className="min-w-0 flex-1 truncate font-medium">{previewName(p)}</span>
              <span className={cn("shrink-0 font-mono text-xs", PREVIEW_TONE[p.status])}>{p.status}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                {p.status !== "stopped" && (
                  <Button size="icon-xs" variant="ghost" asChild title="Open">
                    <a href={p.url} target="_blank" rel="noreferrer" aria-label="Open">
                      <ExternalLink />
                    </a>
                  </Button>
                )}
                <Button size="icon-xs" variant="ghost" title="Logs" aria-label="Logs" onClick={() => setLogsFor(p)}>
                  <FileText />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  disabled={busy === p.id}
                  title={p.status === "stopped" ? "Start" : "Restart"}
                  aria-label={p.status === "stopped" ? "Start" : "Restart"}
                  onClick={() => void act(p, "restart")}
                >
                  <RotateCw className={cn(busy === p.id && "animate-spin")} />
                </Button>
                {p.status !== "stopped" && (
                  <Button size="icon-xs" variant="ghost" disabled={busy === p.id} title="Stop" aria-label="Stop" onClick={() => void act(p, "stop")}>
                    <Square />
                  </Button>
                )}
                <Button size="icon-xs" variant="ghost" disabled={busy === p.id} title="Delete" aria-label="Delete" onClick={() => void act(p, "delete")}>
                  <Trash2 />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-3.5 font-mono text-[11px] text-muted-foreground">
              <a href={p.url} target="_blank" rel="noreferrer" className="truncate hover:text-foreground hover:underline">
                {p.host}
              </a>
              <span>:{p.port}</span>
              <span className="min-w-0 truncate" title={p.command}>
                {p.command}
              </span>
              {p.overridesSetup && (
                <span title="This preview's command or port differs from the project's setup defaults">
                  overrides setup
                </span>
              )}
              {p.source === "branch" && p.branch && (
                <span>
                  {p.branch}
                  {p.headSha ? ` @ ${p.headSha.slice(0, 7)}` : ""}
                </span>
              )}
              {showSandbox && (
                <Link href={`/sandboxes/${p.sandboxId}`} className="hover:text-foreground hover:underline">
                  {shortSandboxId(p.sandboxId)}
                </Link>
              )}
              {p.startedBy !== "user" && (
                <Link href={startedByHref(p.startedBy)} className="hover:text-foreground hover:underline">
                  started by {p.startedBy.slice(0, 10)}…
                </Link>
              )}
              {p.lastRequestAt && (
                <span>
                  opened <LocalTime ms={p.lastRequestAt} />
                </span>
              )}
            </div>
            {p.error && p.status !== "healthy" && (
              <p className="pl-3.5 font-mono text-[11px] text-destructive">{p.error}</p>
            )}
          </li>
        ))}
      </ul>
      <PreviewLogDialog preview={logsFor} onOpenChange={(open) => !open && setLogsFor(null)} />
    </>
  );
}
