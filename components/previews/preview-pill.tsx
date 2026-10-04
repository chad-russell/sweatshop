"use client";

import { ExternalLink, FileText, MonitorPlay, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PreviewView } from "@/lib/previews/service";
import { cn } from "@/lib/utils";

/**
 * 0016: previews in a chat's or run's header. The pill appears while
 * the owner's bound sandbox has a preview that is not stopped: one
 * preview → Open is the pill itself, with a menu for the rest; several →
 * a menu. Polled every 5 s while the tab is visible (the agent may start
 * one mid-turn), never while hidden.
 */

const POLL_MS = 5_000;

export const PREVIEW_TONE: Record<string, string> = {
  healthy: "text-success",
  starting: "text-warning",
  crashed: "text-destructive",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

export function PreviewDot({ status, className }: { status: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        PREVIEW_TONE[status],
        status === "starting" && "animate-pulse",
        className,
      )}
    />
  );
}

export function previewName(p: Pick<PreviewView, "label" | "branch" | "slug">): string {
  return p.label ?? p.branch ?? p.slug;
}

/** Fetch + poll a previews list endpoint. */
export function usePreviews(query: string | null): {
  previews: PreviewView[];
  refresh: () => Promise<void>;
} {
  const [previews, setPreviews] = useState<PreviewView[]>([]);
  const refresh = useCallback(async () => {
    if (query === null) return; // "" IS a query — every preview (the /previews page)
    try {
      const res = await fetch(`/api/previews?${query}`, { cache: "no-store" });
      if (!res.ok) return;
      setPreviews(((await res.json()) as { previews: PreviewView[] }).previews);
    } catch {
      /* transient — the next tick retries */
    }
  }, [query]);
  useEffect(() => {
    if (query === null) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [query, refresh]);
  return { previews, refresh };
}

export async function previewAction(id: string, action: "restart" | "stop" | "delete"): Promise<string | null> {
  const res = await fetch(`/api/previews/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${action} failed (${res.status})`;
}

/** The log sheet: the tail of a preview's server log, refreshable. */
export function PreviewLogDialog({
  preview,
  onOpenChange,
}: {
  preview: PreviewView | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Keyed by preview id so each open starts empty (no stale log, and no
  // synchronous setState inside the fetch effect).
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {preview && <PreviewLogBody key={preview.id} preview={preview} />}
      </DialogContent>
    </Dialog>
  );
}

function PreviewLogBody({ preview }: { preview: PreviewView }) {
  const [log, setLog] = useState<string | null>(null);
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/previews/${preview.id}?logs=300&env=1`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { log?: string; env?: Record<string, string> };
      if (!cancelled) {
        setLog(body.log ?? "");
        setEnv(body.env ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preview.id, nonce]);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PreviewDot status={preview.status} />
          {previewName(preview)} — server log
        </DialogTitle>
        <DialogDescription className="font-mono text-xs">{preview.command}</DialogDescription>
      </DialogHeader>
      {env && Object.keys(env).length > 0 && (
        <div className="rounded-md border border-input p-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Env at launch (values hidden)</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(env).map(([key, value]) => (
              <span key={key} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {key}=<span className="text-muted-foreground">{value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {log === null ? "loading…" : log.trim() || "(empty — the sandbox may be stopped)"}
      </pre>
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={() => setNonce((n) => n + 1)}>
          <RotateCw /> Refresh
        </Button>
      </div>
    </>
  );
}

/** Per-preview actions, shared by the pill menu and the lists. */
function PreviewMenuItems({
  p,
  onLogs,
  onChanged,
}: {
  p: PreviewView;
  onLogs: (p: PreviewView) => void;
  onChanged: () => void;
}) {
  const act = async (action: "restart" | "stop") => {
    const error = await previewAction(p.id, action);
    if (error) alert(error);
    onChanged();
  };
  return (
    <>
      {p.status !== "stopped" && (
        <DropdownMenuItem asChild>
          <a href={p.url} target="_blank" rel="noreferrer">
            <ExternalLink /> Open
          </a>
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={() => onLogs(p)}>
        <FileText /> Logs
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void act("restart")}>
        <RotateCw /> {p.status === "stopped" ? "Start" : "Restart"}
      </DropdownMenuItem>
      {p.status !== "stopped" && (
        <DropdownMenuItem onSelect={() => void act("stop")}>
          <Square /> Stop
        </DropdownMenuItem>
      )}
    </>
  );
}

/**
 * The header pill. `owner` is the chat or run id whose bound sandbox's
 * previews it shows; null renders nothing (fresh chat, no sandbox).
 */
export function PreviewPill({ owner, compact = false }: { owner: string | null; compact?: boolean }) {
  const { previews, refresh } = usePreviews(owner ? `owner=${encodeURIComponent(owner)}` : null);
  const [logsFor, setLogsFor] = useState<PreviewView | null>(null);
  const live = previews.filter((p) => p.status !== "stopped");
  if (live.length === 0) return null;
  const single = live.length === 1 ? live[0]! : null;

  return (
    <>
      <div className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-border text-sm">
        {single ? (
          <a
            href={single.url}
            target="_blank"
            rel="noreferrer"
            title={`${single.url} — ${single.status}`}
            className="inline-flex h-full items-center gap-1.5 px-2.5 transition-colors hover:bg-accent"
          >
            <PreviewDot status={single.status} />
            {!compact && <span className="max-w-32 truncate">{previewName(single)}</span>}
            <span className="font-medium">Open</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </a>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Previews"
              title="Previews running in this sandbox"
              className={cn(
                "inline-flex h-full items-center gap-1.5 px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                single && "border-l border-border",
              )}
            >
              <MonitorPlay className="size-4" />
              {!single && <span className="text-foreground">{live.length} previews</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {live.map((p, i) => (
              <div key={p.id}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="flex items-center gap-2">
                  <PreviewDot status={p.status} />
                  <span className="min-w-0 flex-1 truncate">{previewName(p)}</span>
                  <span className={cn("font-mono text-xs", PREVIEW_TONE[p.status])}>{p.status}</span>
                </DropdownMenuLabel>
                <PreviewMenuItems p={p} onLogs={setLogsFor} onChanged={() => void refresh()} />
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <PreviewLogDialog preview={logsFor} onOpenChange={(open) => !open && setLogsFor(null)} />
    </>
  );
}
