"use client";

import { Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { THEMES } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";

/**
 * Minimal theme cycler: clickhouse → cal → nova. A dropdown can replace it
 * when there are enough themes to warrant one.
 *
 * Deliberately no `disabled` attribute before mount: it was the one
 * attribute that differed between server and client render and tripped a
 * hydration warning. The click is simply a no-op until mounted.
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
      onClick={() => next && setTheme(next.value)}
      className={cn(
        "inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        className,
      )}
    >
      <Palette className="size-4" />
    </button>
  );
}
