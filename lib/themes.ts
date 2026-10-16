/**
 * The theme registry — the single source of truth for which themes exist.
 *
 * A theme is a complete set of the CSS custom properties listed in
 * docs/0044-themes.md under `[data-theme="<id>"]` in `app/themes/<id>.css`
 * (imported by app/globals.css). The registry supplies the metadata the UI
 * needs (label, dark/light kind); the CSS file supplies every token.
 * Adding a theme = one entry here + one file there — tests/themes.test.ts
 * enforces that the two never drift apart.
 */
export type ThemeKind = "dark" | "light";

export interface ThemeEntry {
  /** Value of the data-theme attribute and the CSS file name. */
  id: string;
  /** Human label in the theme picker. */
  label: string;
  /** Whether the scheme is dark or light (future: mode-aware defaults). */
  kind: ThemeKind;
}

export const THEMES: readonly ThemeEntry[] = [
  { id: "clickhouse", label: "ClickHouse", kind: "dark" },
  { id: "everforest", label: "Everforest", kind: "dark" },
  { id: "nord", label: "Nord", kind: "dark" },
  { id: "gruvbox", label: "Gruvbox", kind: "dark" },
  { id: "cal", label: "Cal.com", kind: "light" },
  { id: "nova", label: "Nova", kind: "light" },
] as const;

export const DEFAULT_THEME = "clickhouse";
