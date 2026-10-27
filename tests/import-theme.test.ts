import { describe, expect, it } from "vitest";
import { mapTheme, parseJsonc, renderThemeCss, TOKEN_ORDER } from "../scripts/import-theme.mjs";

/**
 * The importer's mapping core (docs/0086): the scope table, alpha
 * flattening, the --scope-token override and the hard error on missing
 * core colors. The fixture is a small synthetic VSCode theme — the
 * contract wiring itself (registry ↔ CSS ↔ globals) stays in
 * themes.test.ts, which every imported theme must pass too.
 */

const FIXTURE = {
  name: "Fixture Theme",
  type: "dark",
  colors: {
    "editor.background": "#10081e",
    "editor.foreground": "#e8e4f0",
    "button.background": "#7aa2f7",
    "button.foreground": "#10081e",
    focusBorder: "#7aa2f7",
    "list.hoverBackground": "#8a7dff80", // #rrggbbaa — must flatten over editor.background
    descriptionForeground: "#a9b1c1",
    "sideBar.background": "#191024",
    "sideBar.foreground": "#e8e4f0",
    "panel.border": "#2a1f38",
    "input.background": "#241832",
    "editorError.foreground": "#ff5577",
    "editorWarning.foreground": "#f3faa0",
    "editorInfo.foreground": "#23d18b", // contrast vs background ≥ 3:1 — info keeps it
    "terminal.foreground": "#e8e4f0",
    "terminal.ansiBlack": "#2a2438",
    "terminal.ansiRed": "#ff6b81",
    "terminal.ansiGreen": "#5af78e",
    "terminal.ansiYellow": "#e5c07b",
    "terminal.ansiBlue": "#57c7ff",
    "terminal.ansiMagenta": "#ff6ac1",
    "terminal.ansiCyan": "#9aedfe",
    "terminal.ansiBrightWhite": "#ffffff",
  } as Record<string, string | undefined>,
};

describe("import-theme mapTheme", () => {
  it("renders every contract token in the theme CSS", () => {
    const mapped = mapTheme(FIXTURE);
    const css = renderThemeCss({
      id: "fixture",
      label: "Fixture",
      source: "tests/import-theme.test.ts (inline fixture)",
      mapped,
    });
    expect(css).toContain('[data-theme="fixture"] {');
    for (const token of TOKEN_ORDER) {
      expect(css, `token --${token} missing from generated CSS`).toContain(`--${token}:`);
    }
    expect(css).toContain("--brand-claude: #d97757;");
    expect(mapped.tokens.radius).toBe("0.5rem");
  });

  it("flattens #rrggbbaa over editor.background", () => {
    const mapped = mapTheme(FIXTURE);
    // #8a7dff at 50% (0x80) over #10081e composites to #4d438f.
    expect(mapped.tokens.accent).toBe("#4d438f");
    expect(mapped.derivations.some((d) => d.token === "accent" && d.rule.includes("flattened over background"))).toBe(
      true,
    );
  });

  it("applies --scope-token overrides on top of the mapping", () => {
    const mapped = mapTheme(FIXTURE);
    expect(mapped.tokens.warning).toBe("#f3faa0"); // editorWarning.foreground by default
    const overridden = mapTheme(FIXTURE, { scopeTokens: { warning: "terminal.ansiYellow" } });
    expect(overridden.tokens.warning).toBe("#e5c07b");
    expect(overridden.overrides).toEqual([{ token: "warning", scope: "terminal.ansiYellow", value: "#e5c07b" }]);
  });

  it("throws listing the scope when a core color is missing", () => {
    const broken = structuredClone(FIXTURE);
    broken.colors["editorError.foreground"] = undefined;
    expect(() => mapTheme(broken)).toThrow(/editorError\.foreground/);
  });

  it("falls back to terminal.ansiBlue when editorInfo is absent or low-contrast", () => {
    expect(mapTheme(FIXTURE).tokens.info).toBe("#23d18b"); // good contrast kept
    const absent = structuredClone(FIXTURE);
    absent.colors["editorInfo.foreground"] = undefined;
    expect(mapTheme(absent).tokens.info).toBe("#57c7ff");
    const lowContrast = structuredClone(FIXTURE);
    lowContrast.colors["editorInfo.foreground"] = "#241a30"; // ~invisible on #10081e
    expect(mapTheme(lowContrast).tokens.info).toBe("#57c7ff");
  });

  it("derives terminal surface and ink for a dark theme without terminal.background", () => {
    const mapped = mapTheme(FIXTURE);
    expect(mapped.tokens.terminal).toBe("#10081e"); // editor.background fallback
    expect(mapped.tokens["terminal-ink"]).toBe("#10081e"); // dark kind: ink = terminal bg
    expect(mapped.tokens["terminal-bg-black"]).toBe("#2a2438"); // bright absent → normal ANSI
  });

  it("treats fully-transparent colors as absent in chains", () => {
    const transparent = structuredClone(FIXTURE);
    transparent.colors["panel.border"] = "#0000"; // author disabled the border surface
    const mapped = mapTheme(transparent);
    // border falls through its whole chain to the "muted lifted 1 step" derivation
    expect(
      mapped.derivations.some((d) => d.token === "border" && d.rule.includes("derived: muted lifted 1 step")),
    ).toBe(true);
    expect(mapped.tokens.border).not.toBe("#000000");
    expect(mapped.tokens["terminal-border"]).toBe(mapped.tokens.border); // border-token derivation
    expect(mapped.notes.some((n) => n === "panel.border (#0000) fully transparent — treated as absent")).toBe(true);
  });

  it("routes sidebar-ring through ring when focusBorder alpha is below 50%", () => {
    const lowAlpha = structuredClone(FIXTURE);
    lowAlpha.colors.focusBorder = "#7aa2f740"; // 25% alpha — near-invisible flattened
    const mapped = mapTheme(lowAlpha);
    expect(mapped.tokens.ring).toBe("#4d438f"); // accent (flattened list.hoverBackground)
    expect(mapped.tokens["sidebar-ring"]).toBe(mapped.tokens.ring);
    expect(
      mapped.derivations.some(
        (d) => d.token === "sidebar-ring" && d.rule.includes("alpha 25% < 50%") && d.rule.endsWith("→ ring"),
      ),
    ).toBe(true);
  });

  it("parses JSONC sources (comments + trailing commas)", () => {
    const parsed = parseJsonc('{\n  // comment with "quote"\n  "colors": { "editor.background": "#101010", },\n}');
    expect(parsed.colors["editor.background"]).toBe("#101010");
  });
});
