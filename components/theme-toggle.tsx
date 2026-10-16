"use client";

import { Check, Palette } from "lucide-react";
import { useTheme } from "next-themes";
import { THEMES } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Theme picker (docs/0044): dropdown over the registry in lib/themes.ts.
 * The old cycler was replaced once the registry grew past a handful of
 * themes.
 *
 * Deliberately no `disabled` attribute before mount: it was the one
 * attribute that differed between server and client render and tripped a
 * hydration warning (lesson from the cycler it replaces).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  const current = mounted ? (theme ?? THEMES[0].id) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch theme"
        title="Switch theme"
        className={cn(
          "inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md border border-sidebar-border text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          className,
        )}
      >
        <Palette className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => setTheme(t.id)}
            aria-checked={current === t.id}
          >
            <Check
              className={cn("size-4", current === t.id ? "opacity-100" : "opacity-0")}
            />
            {t.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
