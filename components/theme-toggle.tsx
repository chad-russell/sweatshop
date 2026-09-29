"use client";

import { Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { THEMES } from "@/components/theme-provider";
import { useMounted } from "@/lib/use-mounted";

/**
 * Minimal theme cycler: clickhouse → cal → nova. A dropdown can replace it
 * when there are enough themes to warrant one.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  const current = mounted ? (theme ?? "clickhouse") : null;
  const next =
    current === null
      ? null
      : THEMES[(THEMES.findIndex((t) => t.value === current) + 1) % THEMES.length];

  return (
    <button
      type="button"
      aria-label={next ? `Switch theme to ${next.label}` : "Switch theme"}
      title={next ? `Theme: ${current} → ${next.value}` : "Switch theme"}
      disabled={next === null}
      onClick={() => next && setTheme(next.value)}
      className={
        "inline-flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 " +
        (className ?? "")
      }
    >
      <Palette className="size-4" />
    </button>
  );
}
