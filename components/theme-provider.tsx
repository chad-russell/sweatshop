"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";
import { DEFAULT_THEME, THEMES } from "@/lib/themes";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme={DEFAULT_THEME}
      themes={THEMES.map((t) => t.id)}
      enableSystem={false}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
