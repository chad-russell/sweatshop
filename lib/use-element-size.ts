"use client";

import { useEffect, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * The rendered size of an element, kept live with a ResizeObserver.
 * Returns a callback ref plus the size (null until the first measurement,
 * and again while the element is unmounted). Sizes are rounded so
 * sub-pixel jitter never re-renders.
 */
export function useElementSize<T extends HTMLElement>(): [(el: T | null) => void, ElementSize | null] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState<ElementSize | null>(null);
  useEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      setSize(null);
    };
  }, [el]);
  return [setEl, size];
}
