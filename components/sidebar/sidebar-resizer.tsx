"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  clampSidebarWidth,
  parseSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from "@/lib/sidebar-width";

// Hydration-safe external store over localStorage (same pattern as
// use-sidebar-collapsed.ts): the server snapshot is the default width,
// so the first client render matches it exactly — no mismatch warning —
// and the real stored width takes over right after.
const KEY = "sweatshop.sidebar.width";
const STEP = 16;
const listeners = new Set<() => void>();
let cache: { raw: string | null; value: number } | null = null;

function read(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
  if (cache && cache.raw === raw) return cache.value;
  const value = parseSidebarWidth(raw) ?? SIDEBAR_WIDTH_DEFAULT;
  cache = { raw, value };
  return value;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function write(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(px)));
  } catch {
    /* private mode — the width still holds for this tab */
  }
  for (const listener of listeners) listener();
}

function apply(px: number): void {
  document.documentElement.style.setProperty("--sidebar-w", `${Math.round(px)}px`);
}

/**
 * Drag handle on the conversation sidebar's right edge. Like
 * content-resizer.tsx, dragging rewrites a CSS variable (`--sidebar-w`,
 * default in nova.css) on <html> directly for live feedback with no
 * layout flash, and only commits to localStorage (and the reactive
 * `width` used for aria-valuenow) at the end of the gesture. Double-click
 * or Home resets to the default. Not rendered while the sidebar is
 * collapsed or the mobile drawer is open (ConversationSidebar — the
 * drawer keeps its own width).
 */
export function SidebarResizer() {
  const width = useSyncExternalStore(subscribe, read, () => SIDEBAR_WIDTH_DEFAULT);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    apply(width);
  }, [width]);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const left = e.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    apply(clampSidebarWidth(e.clientX - left));
  };
  const up = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const v = document.documentElement.style.getPropertyValue("--sidebar-w");
    write(v ? Number.parseFloat(v) : null);
  };
  const reset = () => {
    apply(SIDEBAR_WIDTH_DEFAULT);
    write(null);
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = width + STEP;
    else if (e.key === "ArrowLeft") next = width - STEP;
    else if (e.key === "Home") return reset();
    if (next === null) return;
    e.preventDefault();
    write(clampSidebarWidth(next));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={Math.round(width)}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={reset}
      onKeyDown={key}
      className="group absolute inset-y-0 right-0 z-10 hidden w-3 translate-x-1/2 cursor-col-resize touch-none md:block"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
}
