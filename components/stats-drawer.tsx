"use client";

import { ChartPie, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * 0047: the chat-header stats drawer. Fetches the group rollup when
 * opened. Semantic tokens only; numbers are mono.
 */

interface ModelUsage {
  key: string;
  label: string;
  provider: string;
  model: string;
  isHarness: boolean;
  costUsd: number | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  steps: number;
  toolCalls: number;
  events: number;
}

interface ChildUsage {
  conversationId: string;
  title: string;
  kind: "conversation" | "harness";
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  workMs: number;
  steps: number;
  href: string;
}

interface StatsPayload {
  rootId: string;
  totals: {
    costUsd: number | null;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    steps: number;
    toolCalls: number;
    workMs: number;
  };
  wallMs: number | null;
  waitMs: number;
  medianWaitMs: number | null;
  touches: number;
  byModel: ModelUsage[];
  byChild: ChildUsage[];
  cacheHitRate: number | null;
}

const CHART = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return min ? `${hours}h ${min}m` : `${hours}h`;
}

function formatUsd(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function Money({ cost, active }: { cost: number | null; active: boolean }) {
  if (cost === null) {
    return active ? <Badge variant="outline">plan</Badge> : <span className="text-muted-foreground">—</span>;
  }
  return <span className="font-mono">{formatUsd(cost)}</span>;
}

function donutSegments(slices: { fraction: number; color: string }[], circ: number) {
  const out: { color: string; len: number; offset: number }[] = [];
  let offset = 0;
  for (const slice of slices) {
    const len = Math.max(0, slice.fraction * circ);
    out.push({ color: slice.color, len, offset });
    offset += len;
  }
  return out;
}

function Donut({ slices, center }: { slices: { fraction: number; color: string }[]; center: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const segments = donutSegments(slices, c);
  return (
    <div className="relative size-28 shrink-0">
      <svg viewBox="0 0 120 120" className="size-full" role="img" aria-label="Cost by model">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--muted)" strokeWidth="12" />
        {segments.map((segment) => (
          <circle
            key={`${segment.offset}-${segment.color}`}
            cx="60"
            cy="60"
            r={r}
            fill="none"
            stroke={segment.color}
            strokeWidth="12"
            strokeDasharray={`${segment.len} ${Math.max(0, c - segment.len)}`}
            strokeDashoffset={-segment.offset}
            transform="rotate(-90 60 60)"
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center font-mono text-sm">{center}</div>
    </div>
  );
}

function StatsBody({ data }: { data: StatsPayload }) {
  if (data.byModel.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No metered usage yet — stats start recording with the next model call.
      </p>
    );
  }

  const metered = data.byModel.filter((row) => row.costUsd !== null);
  const plans = data.byModel.filter((row) => row.costUsd === null);
  const meteredTotal = metered.reduce((n, row) => n + (row.costUsd ?? 0), 0);
  const tokenMax = Math.max(1, ...data.byModel.map((row) => row.inputTokens + row.outputTokens));
  const work = data.totals.workMs;
  const wait = data.waitMs;
  const wall = data.wallMs ?? 0;
  const idle = Math.max(0, wall - work - wait);
  const span = work + wait + idle;
  const share = (n: number) => (span > 0 ? (n / span) * 100 : 0);
  const active = data.totals.inputTokens > 0 || data.totals.outputTokens > 0 || data.totals.steps > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-muted-foreground">Total</div>
          <div className="mt-0.5 text-2xl">
            <Money cost={data.totals.costUsd} active={active} />
          </div>
          {plans.length > 0 && (
            <div className="mt-0.5 text-xs text-muted-foreground">{plans.length} unmetered</div>
          )}
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Wall time</div>
          <div className="mt-0.5 font-mono text-2xl">
            {data.wallMs === null ? "—" : formatDuration(data.wallMs)}
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        agents worked <span className="font-mono text-foreground">{formatDuration(work)}</span>
        {" · "}
        waiting on you <span className="font-mono text-foreground">{formatDuration(wait)}</span>
      </p>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Cost by model</h3>
        <div className="flex items-center gap-4">
          <Donut
            slices={metered.map((row, i) => ({
              fraction: meteredTotal > 0 ? (row.costUsd ?? 0) / meteredTotal : 0,
              color: CHART[i % CHART.length]!,
            }))}
            center={data.totals.costUsd === null ? "plan" : formatUsd(data.totals.costUsd)}
          />
          <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
            {metered.map((row, i) => (
              <li key={row.key} className="text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: CHART[i % CHART.length] }} />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="font-mono">{formatUsd(row.costUsd ?? 0)}</span>
                  <span className="font-mono text-muted-foreground">{percent(row.costUsd ?? 0, meteredTotal)}</span>
                </div>
                <div className="pl-4 font-mono text-muted-foreground">
                  {formatTokens(row.inputTokens + row.outputTokens)} tok · cache{" "}
                  {percent(row.cachedTokens, row.inputTokens)}
                </div>
              </li>
            ))}
            {metered.length === 0 && <li className="text-xs text-muted-foreground">No metered models</li>}
          </ul>
        </div>
        {data.cacheHitRate !== null && (
          <p className="font-mono text-xs text-muted-foreground">
            cache hit {Math.round(data.cacheHitRate * 100)}%
          </p>
        )}
      </section>

      {plans.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Plan</h3>
          <ul className="flex flex-col gap-2">
            {plans.map((row) => (
              <li key={row.key} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatTokens(row.inputTokens)} in · {row.steps} steps · {row.toolCalls} tools
                </span>
                <Badge variant="outline">plan</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Time</h3>
        <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-border">
          <div className="bg-primary" style={{ width: `${share(work)}%` }} />
          <div className="bg-warning" style={{ width: `${share(wait)}%` }} />
          <div className="bg-muted" style={{ width: `${share(idle)}%` }} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>work {formatDuration(work)}</span>
          <span>waiting {formatDuration(wait)}</span>
          <span>idle {formatDuration(idle)}</span>
        </div>
        <div className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
          <span>{data.touches} touches</span>
          {data.medianWaitMs !== null && <span>median wait {formatDuration(data.medianWaitMs)}</span>}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Models</h3>
        {data.byModel.map((row) => {
          const tokens = row.inputTokens + row.outputTokens;
          const used = row.inputTokens > 0 || row.outputTokens > 0 || row.steps > 0;
          return (
            <div key={row.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <Money cost={row.costUsd} active={used} />
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full bg-primary" style={{ width: `${(tokens / tokenMax) * 100}%` }} />
              </div>
              <div className="font-mono text-xs text-muted-foreground">
                {formatTokens(row.inputTokens)} in · {formatTokens(row.cachedTokens)} cached ·{" "}
                {formatTokens(row.outputTokens)} out
                {row.inputTokens > 0 ? ` · cache ${percent(row.cachedTokens, row.inputTokens)}` : ""}
              </div>
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Threads</h3>
        <ul className="flex flex-col">
          {data.byChild.map((child) => {
            const used = child.inputTokens > 0 || child.outputTokens > 0 || child.steps > 0;
            return (
              <li key={child.href}>
                <Link href={child.href} className="flex items-baseline gap-2 rounded-md px-1 py-1.5 hover:bg-muted">
                  <span className="min-w-0 flex-1 truncate text-sm">{child.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{formatDuration(child.workMs)}</span>
                  <span className="text-xs">
                    <Money cost={child.costUsd} active={used} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export function StatsDrawer({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ready"; data: StatsPayload }>({
    kind: "loading",
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    fetch(`/api/x/stats/${conversationId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as StatsPayload;
      })
      .then((data) => {
        if (!cancel) setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!cancel) setState({ kind: "error" });
      });
    return () => {
      cancel = true;
    };
  }, [open, conversationId, attempt]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Usage and cost"
        title="Usage and cost"
        onClick={() => {
          setState({ kind: "loading" });
          setOpen(true);
        }}
      >
        <ChartPie />
      </Button>
      {open && (
        <>
          <button
            type="button"
            aria-label="Close usage stats"
            className="fixed inset-0 z-40 bg-foreground/20"
            onClick={() => setOpen(false)}
          />
          <aside
            role="dialog"
            aria-label="Usage and cost"
            className={cn(
              "fixed inset-y-0 right-0 z-50 flex h-dvh w-96 max-w-full flex-col border-l bg-background shadow-2xl",
              "max-md:w-full",
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
              <ChartPie className="size-4 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">Usage and cost</span>
              <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={() => setOpen(false)}>
                <X />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {state.kind === "loading" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-4" />
                  Loading stats…
                </div>
              )}
              {state.kind === "error" && (
                <div className="flex flex-col items-start gap-2 text-sm">
                  <p className="text-muted-foreground">Could not load stats.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setState({ kind: "loading" });
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              )}
              {state.kind === "ready" && <StatsBody data={state.data} />}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
