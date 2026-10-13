"use client";

import { useLayoutEffect, useRef } from "react";

const KEY = "sweatshop.content.width";
const MIN = 560;
const STEP = 32;

function stored(): number | null {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN ? n : null;
  } catch {
    return null;
  }
}

function persist(px: number | null): void {
  try {
    if (px === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(Math.round(px)));
  } catch {
    /* private mode — the width still holds for this tab */
  }
}

function apply(px: number | null): void {
  const root = document.documentElement.style;
  if (px === null) root.removeProperty("--content-max");
  else root.setProperty("--content-max", `${Math.round(px)}px`);
}

/**
 * Drag handles on both edges of the centered content column. Every page
 * sizes its column with `max-w-(--content-max)` (globals.css owns the
 * default); dragging an edge rewrites that one variable on <html> and
 * remembers it per browser. Double-click or Home resets to the default.
 * Rendered inside the `relative` wrapper around <main> — lg+ only, since
 * below that the column is the whole screen.
 */
export function ContentResizer({ children }: { children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const saved = stored();
    if (saved !== null) apply(saved);
  }, []);

  const bounds = () => {
    const r = wrap.current!.getBoundingClientRect();
    return { center: r.left + r.width / 2, max: r.width };
  };
  const current = () => {
    const col = wrap.current?.querySelector("main > *");
    return col ? col.getBoundingClientRect().width : MIN;
  };

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const { center, max } = bounds();
    apply(Math.min(max, Math.max(MIN, 2 * Math.abs(e.clientX - center))));
  };
  const up = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const v = document.documentElement.style.getPropertyValue("--content-max");
    persist(v ? Number.parseFloat(v) : null);
  };
  const reset = () => {
    apply(null);
    persist(null);
  };
  const key = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const { max } = bounds();
    const w = current();
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = w + STEP * 2;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = w - STEP * 2;
    else if (e.key === "Home") return reset();
    if (next === null) return;
    e.preventDefault();
    next = Math.min(max, Math.max(MIN, next));
    apply(next);
    persist(next);
  };

  const handle = (side: "left" | "right") => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize content width"
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={reset}
      onKeyDown={key}
      style={{
        [side]: "max(0px, calc(50% - min(var(--content-max), 100%) / 2 - 6px))",
      }}
      className="group absolute inset-y-0 z-10 hidden w-3 cursor-col-resize touch-none lg:block"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );

  return (
    <div ref={wrap} className="relative flex h-dvh min-w-0 flex-1">
      {children}
      {handle("left")}
      {handle("right")}
    </div>
  );
}
