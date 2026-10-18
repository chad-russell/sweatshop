"use client";

import { ArrowUpRightIcon, ChevronDownIcon, MonitorPlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { PreviewView } from "@/lib/previews/service";
import type { ToolState } from "@/lib/tool-views/inspect";
import { objectOf } from "@/lib/tool-views/fields";
import { cn } from "@/lib/utils";
import { PREVIEW_TONE, PreviewDot, previewName } from "./preview-pill";

/**
 * 0016: the transcript card for start_preview / preview_status /
 * stop_preview. The call's result is a snapshot, but a preview lives on
 * — so a card naming one preview re-reads its CURRENT status (once on
 * mount, then every 10 s while visible) and offers Open while it serves.
 */

type Outcome =
  | { ok: true; preview?: PreviewView; previews?: PreviewView[]; log?: string; note?: string }
  | { ok: false; code: string; message: string };

function outcomeOf(output: unknown): Outcome | undefined {
  const o = objectOf(output);
  if (!o || typeof o.ok !== "boolean") return undefined;
  return o as unknown as Outcome;
}

function useLivePreview(initial: PreviewView | undefined): PreviewView | undefined {
  const [live, setLive] = useState<PreviewView | undefined>(undefined);
  const id = initial?.id;
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetch(`/api/previews/${id}`, { cache: "no-store" }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const body = (await res.json()) as { preview: PreviewView };
      setLive(body.preview);
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);
  return live && live.id === id ? live : initial;
}

export function PreviewToolCard({
  tool,
  state,
  input,
  output,
  errorText,
}: {
  tool: "start_preview" | "preview_status" | "stop_preview";
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
}) {
  const outcome = outcomeOf(output);
  const single = outcome?.ok ? (outcome.preview ?? (outcome.previews?.length === 1 ? outcome.previews[0] : undefined)) : undefined;
  const preview = useLivePreview(single);
  const list = outcome?.ok && !single ? (outcome.previews ?? []) : [];
  const failed = state === "error" || outcome?.ok === false;
  const [open, setOpen] = useState(false);
  const i = objectOf(input);

  const title =
    tool === "start_preview"
      ? state === "running"
        ? "Starting preview"
        : "Preview"
      : tool === "stop_preview"
        ? "Stopped preview"
        : "Previews";
  const subtitle = preview
    ? previewName(preview)
    : typeof i?.label === "string"
      ? i.label
      : tool === "preview_status"
        ? `${list.length} in this sandbox`
        : "…";
  const log = outcome?.ok ? outcome.log : undefined;
  const body = log || (outcome?.ok && outcome.note) || list.length > 0;
  const error = outcome?.ok === false ? outcome.message : errorText;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "group not-prose my-1 w-full overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        failed ? "border-destructive/40" : "border-border",
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        <MonitorPlayIcon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-muted-foreground")} aria-hidden />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">{title}</span>
          <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{subtitle}</span>
          {preview && (
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:inline">
              {preview.host}
            </span>
          )}
        </div>
        {state === "running" ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-info">
            <PreviewDot status="starting" className="text-info" /> starting
          </span>
        ) : preview ? (
          <span className={cn("inline-flex items-center gap-1.5 font-mono text-[10px]", PREVIEW_TONE[preview.status])}>
            <PreviewDot status={preview.status} /> {preview.status}
          </span>
        ) : failed ? (
          <span className="font-mono text-[10px] text-destructive">failed</span>
        ) : null}
        {preview && preview.status !== "stopped" && (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          >
            Open
            <ArrowUpRightIcon className="size-3" aria-hidden />
          </a>
        )}
        {body && (
          <CollapsibleTrigger
            aria-label={open ? "Hide details" : "Show details"}
            className="-mr-1 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
        )}
      </div>
      {body && (
        <CollapsibleContent>
          <div className="space-y-2 border-t border-border bg-muted/30 px-3 py-2.5 text-[12.5px]">
            {preview && <p className="font-mono text-[11px] text-muted-foreground">{preview.command} · :{preview.port}</p>}
            {outcome?.ok && outcome.note && <p className="text-muted-foreground">{outcome.note}</p>}
            {list.length > 0 && (
              <ul className="space-y-1">
                {list.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <PreviewDot status={p.status} />
                    <span className="font-medium">{previewName(p)}</span>
                    <a href={p.url} target="_blank" rel="noreferrer" className="truncate font-mono text-[11px] text-muted-foreground hover:underline">
                      {p.host}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {log && (
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{log}</pre>
            )}
          </div>
        </CollapsibleContent>
      )}
      {error && (
        <p className="border-t border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[11px] break-words text-destructive">
          {error}
        </p>
      )}
    </Collapsible>
  );
}
