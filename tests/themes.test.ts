import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { THEMES, DEFAULT_THEME } from "../lib/themes";

/**
 * The theme contract as a test (DESIGN.md rule 2 + docs/0044): the
 * registry in lib/themes.ts and the CSS files in app/themes/ must stay
 * in lockstep — same ids, every contract token present in every theme.
 * A theme with holes is a broken app; this makes that a build failure.
 */

const THEMES_DIR = path.join(process.cwd(), "app", "themes");

const CONTRACT_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "radius",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "success",
  "warning",
  "info",
  "brand-claude",
  "terminal",
  "terminal-foreground",
  "terminal-muted",
  "terminal-border",
  "terminal-red",
  "terminal-green",
  "terminal-yellow",
  "terminal-blue",
  "terminal-magenta",
  "terminal-cyan",
  "terminal-black",
  "terminal-white",
  "terminal-ink",
  "terminal-bg-black",
  "terminal-bg-red",
  "terminal-bg-green",
  "terminal-bg-yellow",
  "terminal-bg-blue",
  "terminal-bg-magenta",
  "terminal-bg-cyan",
  "terminal-bg-white",
] as const;

/** Map of theme id → the css file content holding its token block. */
function themeCss(): Map<string, string> {
  const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith(".css"));
  const byId = new Map<string, string>();
  for (const f of files) {
    const content = readFileSync(path.join(THEMES_DIR, f), "utf8");
    const selector = content.match(/\[data-theme="([a-z0-9-]+)"\]/);
    // nova.css is :root,[data-theme="nova"]; every file must carry a selector
    if (!selector) {
      throw new Error(`app/themes/${f} has no [data-theme] selector`);
    }
    byId.set(selector[1], content);
  }
  return byId;
}

/** Custom properties declared inside a `[data-theme]` rule. */
function declaredTokens(css: string, id: string): Set<string> {
  const block = css.match(new RegExp(`\\[data-theme="${id}"\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
  if (!block) throw new Error(`no [data-theme="${id}"] block found`);
  const tokens = new Set<string>();
  for (const m of block[1].matchAll(/^\s*--([a-z0-9-]+):/gm)) tokens.add(m[1]);
  return tokens;
}

describe("theme registry ↔ CSS contract", () => {
  const css = themeCss();

  it("every registry entry has a CSS file defining every contract token", () => {
    for (const theme of THEMES) {
      const content = css.get(theme.id);
      expect(content, `app/themes/${theme.id}.css missing`).toBeDefined();
      const declared = declaredTokens(content!, theme.id);
      const missing = CONTRACT_TOKENS.filter((t) => !declared.has(t));
      expect(
        missing,
        `theme ${theme.id} is missing tokens: ${missing.join(", ")}`,
      ).toEqual([]);
    }
  });

  it("every CSS theme has a registry entry", () => {
    for (const id of css.keys()) {
      expect(
        THEMES.some((t) => t.id === id),
        `app/themes/${id}.css exists but ${id} is not in lib/themes.ts THEMES`,
      ).toBe(true);
    }
  });

  it("globals.css imports every theme file", () => {
    const globals = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
    for (const theme of THEMES) {
      expect(
        globals.includes(`@import "./themes/${theme.id}.css"`),
        `globals.css does not import themes/${theme.id}.css`,
      ).toBe(true);
    }
  });

  it("default theme is in the registry", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME)).toBe(true);
  });

  it("nova (the :root fallback) is imported before every other theme", () => {
    // On <html> the :root and [data-theme] selectors tie on specificity,
    // so a later :root block would clobber every theme above it. The
    // fallback has to land first.
    const globals = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
    const imports = [...globals.matchAll(/@import "\.\/(themes\/[a-z0-9-]+\.css)";/g)].map((m) => m[1]);
    expect(imports.length).toBe(THEMES.length);
    expect(imports[0]).toBe("themes/nova.css");
  });

  it("registry ids are unique", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
