"use client";

import dynamic from "next/dynamic";

/**
 * 0014: React Flow measures the DOM, so the graph is client-only and
 * loaded lazily — it never reaches the server bundle or blocks a page's
 * first paint.
 */
export const LazyMachineGraph = dynamic(
  () => import("./machine-graph").then((m) => m.MachineGraph),
  {
    ssr: false,
    loading: () => <div className="h-full w-full animate-pulse rounded-md bg-muted/40" />,
  },
);
