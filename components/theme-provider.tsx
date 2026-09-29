"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export const THEMES = [
  { value: "clickhouse", label: "ClickHouse" },
  { value: "cal", label: "Cal.com" },
  { value: "nova", label: "Nova" },
] as const;

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="clickhouse"
      themes={THEMES.map((t) => t.value)}
      enableSystem={false}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
