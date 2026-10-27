/**
 * VSCode theme importer (docs/0086-vscode-theme-import.md).
 *
 * Maps a vendored VSCode workbench color theme (JSON or JSONC) onto the
 * app's theme token contract (docs/0044) and writes the same files a
 * hand-made theme uses: app/themes/<id>.css, a lib/themes.ts registry
 * entry, the app/globals.css import and — for dark themes — an entry in
 * the @custom-variant dark selector list. Zero dependencies; run by
 * hand as a curation step, never at runtime:
 *
 *   node scripts/import-theme.mjs design/<dir>/<theme>.json <id> "<Label>" \
 *     [--kind dark|light] [--radius 0.5rem] \
 *     [--scope-token <token>=<vscode-scope>]  # repeatable
 *
 * The mapping table in docs/0086 is the contract: first-choice scope,
 * fallback chain, derivation rule. Missing core colors are a hard
 * error; every fallback/derivation is printed for the curation pass
 * (0044's rule: never silently omit).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The token contract in house order — identical to tests/themes.test.ts's
 * CONTRACT_TOKENS and the property order in app/themes/*.css.
 */
export const TOKEN_ORDER = [
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
];

/** oklab lightness shift for "lifted/dimmed 1 step". */
const OKLAB_STEP = 0.07;
/** ANSI hues in chart order (docs/0086: blue/green/yellow/magenta/red). */
const CHART_ANSI = ["Blue", "Green", "Yellow", "Magenta", "Red"];
const ANSI_HUES = ["Red", "Green", "Yellow", "Blue", "Magenta", "Cyan"];

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/** Strip // and block comments, aware of string literals. */
function stripComments(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Drop commas whose next non-space character closes the current object/array. */
function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") {
        i += 1; // drop the trailing comma
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Parse JSON or JSONC (comments + trailing commas), as VSCode themes ship. */
export function parseJsonc(text) {
  try {
    return JSON.parse(stripTrailingCommas(stripComments(text)));
  } catch (err) {
    throw new Error(`theme source is not valid JSON/JSONC: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

/** Parse #rgb/#rgba/#rrggbb/#rrggbbaa → {r,g,b,a} (a in 0..1), else null. */
function parseColor(value) {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-f]+)$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  const pair = (c) => parseInt(c + c, 16);
  if (h.length === 3) return { r: pair(h[0]), g: pair(h[1]), b: pair(h[2]), a: 1 };
  if (h.length === 4) return { r: pair(h[0]), g: pair(h[1]), b: pair(h[2]), a: pair(h[3]) / 255 };
  if (h.length === 6)
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  if (h.length === 8)
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  return null;
}

function toHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Composite a possibly-translucent color over an opaque background. */
function flatten(color, bg) {
  if (color.a >= 1) return { r: color.r, g: color.g, b: color.b, a: 1 };
  const t = color.a;
  return {
    r: color.r * t + bg.r * (1 - t),
    g: color.g * t + bg.g * (1 - t),
    b: color.b * t + bg.b * (1 - t),
    a: 1,
  };
}

// oklab (CSS Color 4) — lightness moves for the lift/dim derivations.
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v) {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}
function toOklab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}
function fromOklab({ L, a, b }) {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l ** 3;
  const m3 = m ** 3;
  const s3 = s ** 3;
  return {
    r: linearToSrgb(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: linearToSrgb(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: linearToSrgb(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
  };
}
/** Shift oklab lightness by delta, clamped. */
function shiftLightness(color, delta) {
  const lab = toOklab(color);
  const L = Math.min(1, Math.max(0, lab.L + delta));
  return fromOklab({ ...lab, L });
}

/** YIQ luma (0..255) — the "contrast pick" metric in docs/0086. */
function yiq({ r, g, b }) {
  return (299 * r + 587 * g + 114 * b) / 1000;
}

/** WCAG relative luminance → contrast ratio (for the info < 3:1 rule). */
function relLum({ r, g, b }) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
function contrastRatio(a, b) {
  const la = relLum(a);
  const lb = relLum(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Mapping (docs/0086 table — the contract)
// ---------------------------------------------------------------------------

/**
 * Map a parsed VSCode theme JSON onto the token contract.
 *
 * opts:
 *   kind         "dark" | "light" (default: the theme's `type`, else dark)
 *   radius       CSS length for --radius (default "0.5rem")
 *   scopeTokens  { token: vscodeScope } — pins a token to a scope,
 *                overriding its mapping row (the --scope-token flag)
 *
 * Returns { kind, name, author, tokens, derivations, overrides, notes }.
 * Throws (listing every missing scope) when a core color is absent.
 */
export function mapTheme(themeJson, opts = {}) {
  if (!themeJson || typeof themeJson !== "object")
    throw new Error("mapTheme: theme JSON root must be an object");
  const colors = themeJson.colors;
  if (!colors || typeof colors !== "object" || Array.isArray(colors))
    throw new Error("mapTheme: theme JSON has no workbench `colors` object");

  let kind = themeJson.type === "light" ? "light" : "dark";
  if (opts.kind != null) {
    if (opts.kind !== "dark" && opts.kind !== "light")
      throw new Error(`mapTheme: kind must be "dark" or "light", got "${opts.kind}"`);
    kind = opts.kind;
  }

  const tokens = new Map();
  const derivations = []; // { token, rule } — every fallback/derivation used
  const overrides = []; // { token, scope, value } — --scope-token pins
  const notes = []; // present-but-unusable scope values
  const missing = new Map(); // scope → tokens that need it

  const missingScope = (scope, token) => {
    const list = missing.get(scope) ?? [];
    list.push(token);
    missing.set(scope, list);
  };
  const addNote = (note) => {
    if (!notes.includes(note)) notes.push(note);
  };
  const parsed = (scope) => {
    const raw = colors[scope];
    if (raw == null || raw === "") return null;
    const c = parseColor(raw);
    if (!c) {
      addNote(`${scope}: present but not a #hex color ("${raw}") — ignored`);
      return null;
    }
    if (c.a === 0) {
      // alpha 0 = the theme author disabled that surface; flattened it
      // would be the background itself (e.g. an invisible border), so
      // chains treat it as absent and fall through.
      addNote(`${scope} (${raw}) fully transparent — treated as absent`);
      return null;
    }
    return c;
  };

  // background resolves first: every other alpha flattens over it.
  const bgFallback = kind === "light" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  let bg = bgFallback;
  {
    const first = parsed("editor.background");
    const chosen = first ?? parsed("editorGutter.background");
    if (!chosen) {
      missingScope("editor.background", "background");
    } else {
      if (!first)
        derivations.push({ token: "background", rule: "editor.background absent → editorGutter.background" });
      bg = flatten(chosen, bgFallback);
      tokens.set("background", toHex(bg));
    }
  }

  /** Read a scope flattened over the background; keeps the raw alpha. */
  const read = (scope) => {
    const c = parsed(scope);
    if (!c) return null;
    return { color: flatten(c, bg), alpha: c.a };
  };
  /** Try scopes in order → hex string, or null. Records fallback derivations. */
  const chain = (token, scopes) => {
    for (let i = 0; i < scopes.length; i += 1) {
      const v = read(scopes[i]);
      if (!v) continue;
      const parts = [];
      if (i > 0) parts.push(`${scopes.slice(0, i).join(", ")} absent → ${scopes[i]}`);
      if (v.alpha < 1)
        parts.push(`${colors[scopes[i]]} flattened over background (alpha ${Math.round(v.alpha * 100)}%)`);
      if (parts.length > 0) derivations.push({ token, rule: parts.join("; ") });
      return toHex(v.color);
    }
    return null;
  };
  const derived = (token, rule, color) => {
    derivations.push({ token, rule: `derived: ${rule}` });
    return toHex(color ?? bg);
  };
  /** lift = away from the background (white for dark, black for light); dim = toward it. */
  const lift = (c, n = OKLAB_STEP) => shiftLightness(c, kind === "dark" ? n : -n);
  const dim = (c, n) => shiftLightness(c, kind === "dark" ? -n : n);
  /** The foreground/background pair member that contrasts better with a surface (YIQ). */
  const contrastPick = (token, surfaceHex) => {
    const fg = parseColor(tokens.get("foreground"));
    const surface = parseColor(surfaceHex);
    const value =
      fg && surface && Math.abs(yiq(fg) - yiq(surface)) >= Math.abs(yiq(bg) - yiq(surface)) ? fg : bg;
    return derived(token, "contrast pick (foreground/background by YIQ vs the surface)", value);
  };
  /**
   * ring/sidebar-ring: focusBorder only when its alpha survives flattening
   * (≥50%); below that it is near-invisible, so both fall back — ring to
   * the accent token, sidebar-ring to the already-resolved ring token.
   */
  const focusRing = (token, fallbackToken) => {
    const fb = read("focusBorder");
    if (fb && fb.alpha >= 0.5) {
      if (fb.alpha < 1)
        derivations.push({ token, rule: `focusBorder (${colors.focusBorder}) flattened over background` });
      tokens.set(token, toHex(fb.color));
      return;
    }
    const why = fb
      ? `focusBorder (${colors.focusBorder}) alpha ${Math.round(fb.alpha * 100)}% < 50% — near-invisible flattened`
      : "focusBorder absent";
    derivations.push({ token, rule: `${why} → ${fallbackToken}` });
    tokens.set(token, tokens.get(fallbackToken));
  };
  const rgbToken = (token) => parseColor(tokens.get(token));
  const placeholder = kind === "dark" ? "#ffffff" : "#000000";

  // --scope-token overrides: pinned scopes resolve before their rows.
  for (const [token, scope] of Object.entries(opts.scopeTokens ?? {})) {
    if (!TOKEN_ORDER.includes(token) || token === "radius" || token === "brand-claude")
      throw new Error(
        `--scope-token: "${token}" is not a theme color token (must be a contract token, e.g. warning, primary, ring)`,
      );
    const v = read(scope);
    if (!v) {
      missingScope(`${scope} (--scope-token override for ${token})`, token);
      tokens.set(token, placeholder);
    } else {
      tokens.set(token, toHex(v.color));
    }
    overrides.push({ token, scope, value: tokens.get(token) });
  }

  const resolvers = {
    background: () => tokens.set("background", toHex(bg)),
    foreground: () => {
      const v = read("editor.foreground");
      if (v) tokens.set("foreground", toHex(v.color));
      else {
        missingScope("editor.foreground", "foreground");
        tokens.set("foreground", placeholder);
      }
    },
    card: () =>
      tokens.set(
        "card",
        chain("card", ["editorWidget.background", "dropdown.background", "sideBar.background"]) ??
          derived("card", "background lifted 1 step", lift(bg)),
      ),
    "card-foreground": () =>
      tokens.set(
        "card-foreground",
        chain("card-foreground", ["editorWidget.foreground", "dropdown.foreground"]) ??
          derived("card-foreground", "foreground", rgbToken("foreground")),
      ),
    popover: () =>
      tokens.set(
        "popover",
        chain("popover", ["dropdown.background", "editorWidget.background", "quickInput.background"]) ??
          derived("popover", "card lifted 1 step", lift(rgbToken("card"))),
      ),
    "popover-foreground": () =>
      tokens.set(
        "popover-foreground",
        chain("popover-foreground", ["dropdown.foreground", "editorWidget.foreground"]) ??
          derived("popover-foreground", "foreground", rgbToken("foreground")),
      ),
    primary: () =>
      tokens.set(
        "primary",
        chain("primary", ["button.background", "focusBorder", "activityBarBadge.background"]) ??
          derived("primary", "focusBorder absent too — background lifted 1 step", lift(bg)),
      ),
    "primary-foreground": () =>
      tokens.set(
        "primary-foreground",
        chain("primary-foreground", ["button.foreground"]) ??
          contrastPick("primary-foreground", tokens.get("primary")),
      ),
    secondary: () => {
      let v = chain("secondary", ["secondaryButton.background"]);
      if (!v) {
        const btn = read("button.background");
        if (btn) v = derived("secondary", "button.background dimmed 25% onto background", dim(btn.color, 0.25));
      }
      if (!v) {
        const input = read("input.background");
        v = input
          ? derived("secondary", "input.background", input.color)
          : derived("secondary", "no source — background lifted 1 step", lift(bg));
      }
      tokens.set("secondary", v);
    },
    "secondary-foreground": () =>
      tokens.set(
        "secondary-foreground",
        chain("secondary-foreground", ["secondaryButton.foreground"]) ??
          derived("secondary-foreground", "foreground", rgbToken("foreground")),
      ),
    muted: () =>
      tokens.set(
        "muted",
        chain("muted", ["sideBar.background", "editorGroupHeader.noTabsBackground", "panel.background"]) ??
          derived("muted", "background dimmed 4%", dim(bg, 0.04)),
      ),
    "muted-foreground": () =>
      tokens.set(
        "muted-foreground",
        chain("muted-foreground", ["descriptionForeground", "sideBar.foreground"]) ??
          derived(
            "muted-foreground",
            "foreground at 60% over background (dimmed)",
            flatten({ ...rgbToken("foreground"), a: 0.6 }, bg),
          ),
      ),
    accent: () =>
      tokens.set(
        "accent",
        chain("accent", ["list.hoverBackground", "list.activeSelectionBackground"]) ??
          derived("accent", "muted lifted 1 step", lift(rgbToken("muted"))),
      ),
    "accent-foreground": () =>
      tokens.set(
        "accent-foreground",
        chain("accent-foreground", ["list.hoverForeground", "list.activeSelectionForeground", "sideBar.foreground"]) ??
          derived("accent-foreground", "foreground", rgbToken("foreground")),
      ),
    destructive: () => {
      const v = read("editorError.foreground");
      if (v) tokens.set("destructive", toHex(v.color));
      else {
        missingScope("editorError.foreground", "destructive");
        tokens.set("destructive", "#ff0000");
      }
    },
    "destructive-foreground": () =>
      tokens.set(
        "destructive-foreground",
        chain("destructive-foreground", ["button.foreground"]) ??
          contrastPick("destructive-foreground", tokens.get("destructive")),
      ),
    border: () =>
      tokens.set(
        "border",
        chain("border", ["panel.border", "widget.border", "editorGroup.border", "contrastBorder"]) ??
          derived("border", "muted lifted 1 step", lift(rgbToken("muted"))),
      ),
    input: () =>
      tokens.set("input", chain("input", ["input.background"]) ?? derived("input", "secondary", rgbToken("secondary"))),
    ring: () => focusRing("ring", "accent"),
    radius: () => tokens.set("radius", opts.radius ?? "0.5rem"),
    sidebar: () =>
      tokens.set(
        "sidebar",
        chain("sidebar", ["sideBar.background", "activityBar.background"]) ??
          derived("sidebar", "background dimmed 2%", dim(bg, 0.02)),
      ),
    "sidebar-foreground": () =>
      tokens.set(
        "sidebar-foreground",
        chain("sidebar-foreground", ["sideBar.foreground"]) ??
          derived("sidebar-foreground", "foreground", rgbToken("foreground")),
      ),
    "sidebar-primary": () =>
      tokens.set(
        "sidebar-primary",
        chain("sidebar-primary", ["activityBarBadge.background"]) ??
          // "accent, focusBorder, primary" — the accent token always
          // resolves (its own row derives), so the later links never fire.
          derived("sidebar-primary", "accent", rgbToken("accent")),
      ),
    "sidebar-primary-foreground": () =>
      tokens.set(
        "sidebar-primary-foreground",
        chain("sidebar-primary-foreground", ["activityBar.foreground"]) ??
          contrastPick("sidebar-primary-foreground", tokens.get("sidebar-primary")),
      ),
    "sidebar-accent": () =>
      tokens.set(
        "sidebar-accent",
        chain("sidebar-accent", ["list.inactiveSelectionBackground", "sideBarSectionHeader.background"]) ??
          derived("sidebar-accent", "accent", rgbToken("accent")),
      ),
    "sidebar-accent-foreground": () =>
      tokens.set(
        "sidebar-accent-foreground",
        chain("sidebar-accent-foreground", ["sideBarSectionHeader.foreground", "list.hoverForeground"]) ??
          derived("sidebar-accent-foreground", "accent-foreground", rgbToken("accent-foreground")),
      ),
    "sidebar-border": () =>
      tokens.set(
        "sidebar-border",
        chain("sidebar-border", ["sideBar.border", "panel.border", "contrastBorder"]) ??
          derived("sidebar-border", "border", rgbToken("border")),
      ),
    "sidebar-ring": () => focusRing("sidebar-ring", "ring"),
    success: () => {
      let v = chain("success", ["editorInfo.foreground", "terminal.ansiGreen", "editorHint.foreground"]);
      if (!v) {
        const green = read("terminal.ansiGreen");
        if (green) v = derived("success", "terminal.ansiGreen", green.color);
        else {
          missingScope("terminal.ansiGreen", "success");
          v = "#00ff00";
        }
      }
      tokens.set("success", v);
    },
    warning: () => {
      let v = chain("warning", ["editorWarning.foreground", "terminal.ansiYellow"]);
      if (!v) {
        const yellow = read("terminal.ansiYellow");
        if (yellow) v = derived("warning", "terminal.ansiYellow", yellow.color);
        else {
          missingScope("terminal.ansiYellow", "warning");
          v = "#ffff00";
        }
      }
      tokens.set("warning", v);
    },
    info: () => {
      // docs/0086 note: editorInfo unless its contrast vs background is
      // below 3:1 (some themes ship a near-invisible one), then ANSI blue.
      const ei = read("editorInfo.foreground");
      if (ei && contrastRatio(ei.color, bg) >= 3) {
        tokens.set("info", toHex(ei.color));
        return;
      }
      const why = ei
        ? `editorInfo.foreground (${colors["editorInfo.foreground"]}) contrast ${contrastRatio(ei.color, bg).toFixed(1)}:1 < 3:1`
        : "editorInfo.foreground absent";
      const blue = read("terminal.ansiBlue");
      if (blue) {
        derivations.push({ token: "info", rule: `${why} → terminal.ansiBlue` });
        tokens.set("info", toHex(blue.color));
      } else {
        missingScope("terminal.ansiBlue", "info");
        tokens.set("info", "#0000ff");
      }
    },
    "brand-claude": () => tokens.set("brand-claude", "#d97757"),
    terminal: () =>
      tokens.set(
        "terminal",
        chain("terminal", ["terminal.background", "editor.background"]) ?? derived("terminal", "background", bg),
      ),
    "terminal-foreground": () =>
      tokens.set(
        "terminal-foreground",
        chain("terminal-foreground", ["terminal.foreground"]) ??
          derived("terminal-foreground", "foreground", rgbToken("foreground")),
      ),
    "terminal-muted": () =>
      tokens.set(
        "terminal-muted",
        chain("terminal-muted", ["descriptionForeground", "terminal.ansiBrightBlack"]) ??
          derived("terminal-muted", "muted-foreground", rgbToken("muted-foreground")),
      ),
    "terminal-border": () =>
      tokens.set(
        "terminal-border",
        chain("terminal-border", ["panel.border", "widget.border"]) ??
          derived("terminal-border", "border", rgbToken("border")),
      ),
    "terminal-ink": () =>
      // Repo convention: bg-ANSI chips are bright and the ink drawn on
      // them is the theme's own terminal surface — its foreground for
      // light themes, its background for dark ones.
      tokens.set(
        "terminal-ink",
        toHex((kind === "light" ? rgbToken("terminal-foreground") : rgbToken("terminal")) ?? bg),
      ),
    "terminal-white": () => {
      const v = chain("terminal-white", ["terminal.ansiBrightWhite", "terminal.ansiWhite"]);
      if (v) tokens.set("terminal-white", v);
      else {
        missingScope("terminal.ansiBrightWhite/terminal.ansiWhite", "terminal-white");
        tokens.set("terminal-white", placeholder);
      }
    },
    chart: (i) => {
      const name = CHART_ANSI[i];
      tokens.set(
        `chart-${i + 1}`,
        chain(`chart-${i + 1}`, [`terminal.ansi${name}`, `terminal.ansiBright${name}`]) ?? toHex(bg),
      );
    },
  };
  for (const [i, token] of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"].entries()) {
    resolvers[token] = () => resolvers.chart(i);
  }
  for (const hue of ANSI_HUES) {
    const key = `terminal-${hue.toLowerCase()}`;
    resolvers[key] = () => {
      const v = chain(key, [`terminal.ansi${hue}`, `terminal.ansiBright${hue}`]);
      if (v) tokens.set(key, v);
      else {
        missingScope(`terminal.ansi${hue}`, key);
        tokens.set(key, "#ff00ff");
      }
    };
  }
  resolvers["terminal-black"] = () => {
    const v = chain("terminal-black", ["terminal.ansiBlack"]);
    if (v) tokens.set("terminal-black", v);
    else {
      missingScope("terminal.ansiBlack", "terminal-black");
      tokens.set("terminal-black", placeholder);
    }
  };
  for (const hue of ["Black", ...ANSI_HUES, "White"]) {
    const key = `terminal-bg-${hue.toLowerCase()}`;
    resolvers[key] = () => {
      tokens.set(key, chain(key, [`terminal.ansiBright${hue}`, `terminal.ansi${hue}`]) ?? toHex(bg));
    };
  }

  for (const token of TOKEN_ORDER) {
    if (tokens.has(token)) continue;
    const resolver = resolvers[token];
    if (!resolver) throw new Error(`importer bug: no resolver for token "${token}"`);
    resolver();
  }

  if (missing.size > 0) {
    const list = [...missing.entries()]
      .map(([scope, needing]) => `${scope} (needed by ${[...new Set(needing)].join(", ")})`)
      .join("; ");
    throw new Error(`theme is missing core colors: ${list}`);
  }

  return {
    kind,
    name: typeof themeJson.name === "string" ? themeJson.name : null,
    author: typeof themeJson.author === "string" ? themeJson.author : null,
    tokens: Object.fromEntries(TOKEN_ORDER.map((t) => [t, tokens.get(t)])),
    derivations,
    overrides,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Rendering + repo edits
// ---------------------------------------------------------------------------

const COMMENT_WIDTH = 67; // content width inside "/* ... */" (matches app/themes/*.css)

function wrapWords(text, width) {
  const lines = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && `${cur} ${word}`.length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Frame paragraphs as the header comment block used by app/themes/*.css. */
function commentBlock(paragraphs) {
  const dashes = "-".repeat(66);
  const lines = [`/* ${dashes} */`];
  for (const p of paragraphs) {
    for (const l of wrapWords(p, COMMENT_WIDTH)) lines.push(`/* ${l.padEnd(COMMENT_WIDTH)} */`);
  }
  lines.push(`/* ${dashes} */`);
  return lines.join("\n");
}

/** Render the complete app/themes/<id>.css file for a mapped theme. */
export function renderThemeCss({ id, label, source, mapped }) {
  const upstream = mapped.name
    ? `"${mapped.name}"${mapped.author ? ` by ${mapped.author}` : ""}`
    : "unknown upstream";
  const header = commentBlock([
    `${id} — ${mapped.kind}. ${label}, imported from upstream ${upstream}.`,
    `Vendored source: ${source}. Imported via scripts/import-theme.mjs (docs/0086).`,
  ]);
  const lines = [`[data-theme="${id}"] {`];
  for (const token of TOKEN_ORDER) {
    if (token === "terminal") lines.push(`  /* terminal surface: ${id} ANSI on the imported terminal palette */`);
    if (token === "terminal-black")
      lines.push(
        "  /* ANSI black/white fg, and background colours (bright in every theme: text on them is terminal-ink) */",
      );
    if (token === "brand-claude")
      lines.push(`  --brand-claude: ${mapped.tokens[token]}; /* Claude's brand orange, same in every theme */`);
    else lines.push(`  --${token}: ${mapped.tokens[token]};`);
  }
  lines.push("}");
  return `${header}\n${lines.join("\n")}\n`;
}

const REGISTRY_ENTRY_RE = /^\s*\{ id: "([a-z0-9-]+)", label: ".*", kind: "(dark|light)" \},$/;

function registryOrder(registryText) {
  const ids = [];
  for (const line of registryText.split("\n")) {
    const m = REGISTRY_ENTRY_RE.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** Insert (or update in place) the THEMES entry; new ids go after the last same-kind entry. */
function insertRegistryEntry(src, { id, label, kind }) {
  const lines = src.split("\n");
  let updateAt = -1;
  let insertAfter = -1;
  let afterId = null;
  lines.forEach((line, idx) => {
    const m = REGISTRY_ENTRY_RE.exec(line);
    if (!m) return;
    if (m[1] === id) updateAt = idx;
    if (m[2] === kind) {
      insertAfter = idx;
      afterId = m[1];
    }
  });
  const entry = `  { id: "${id}", label: "${label}", kind: "${kind}" },`;
  if (updateAt >= 0) {
    lines[updateAt] = entry;
    return { text: lines.join("\n"), afterId, inserted: false };
  }
  if (insertAfter < 0) insertAfter = lines.findIndex((l) => REGISTRY_ENTRY_RE.test(l)); // first entry as fallback
  lines.splice(insertAfter + 1, 0, entry);
  return { text: lines.join("\n"), afterId, inserted: true };
}

/** Rebuild the contiguous theme-import run in registry order (nova first). */
function updateGlobalsImports(src, orderedIds) {
  const importRe = /^@import "\.\/themes\/([a-z0-9-]+)\.css";$/;
  const lines = src.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (importRe.test(lines[i])) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      break;
    }
  }
  if (start < 0) throw new Error("app/globals.css: no theme @import block found");
  const current = lines.slice(start, end + 1).map((l) => importRe.exec(l)[1]);
  const expected = ["nova", ...orderedIds.filter((x) => x !== "nova")];
  const fresh = expected.filter((x) => !current.includes(x));
  if (fresh.length > 1) throw new Error(`app/globals.css: unexpected theme imports to add: [${fresh.join(", ")}]`);
  const rebuilt = expected.map((themeId) => `@import "./themes/${themeId}.css";`);
  lines.splice(start, end - start + 1, ...rebuilt);
  const added = fresh[0] ?? expected[expected.length - 1];
  return { text: lines.join("\n"), after: expected[expected.indexOf(added) - 1] ?? null };
}

/** Add the theme's selector pair to the @custom-variant dark list (idempotent; removes on light). */
function extendDarkVariant(src, id, kind) {
  const hasPair = src.includes(`[data-theme="${id}"]`);
  if (kind !== "dark") {
    if (!hasPair) return src;
    const lines = src
      .split("\n")
      .filter((l) => !new RegExp(`^\\s*\\[data-theme="${id}"\\]( \\*)?,?$`).test(l));
    // re-close the list: the new last entry loses its trailing comma
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^\s*\[data-theme="[a-z0-9-]+"\] \*,?$/.test(lines[i])) {
        lines[i] = lines[i].replace(/,$/, "");
        break;
      }
    }
    return lines.join("\n");
  }
  if (hasPair) return src;
  const lines = src.split("\n");
  let last = -1;
  lines.forEach((line, idx) => {
    if (/^\s*\[data-theme="[a-z0-9-]+"\] \*,?$/.test(line)) last = idx;
  });
  if (last < 0) throw new Error("app/globals.css: @custom-variant dark selector list not found");
  if (!lines[last].endsWith(",")) lines[last] = `${lines[last]},`; // it was the closing entry
  lines.splice(last + 1, 0, `    [data-theme="${id}"],`, `    [data-theme="${id}"] *`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: node scripts/import-theme.mjs <theme.json> <id> "<Label>" \\
         [--kind dark|light] [--radius 0.5rem] \\
         [--scope-token <token>=<vscode-scope>]   (repeatable)`;

function parseArgs(argv) {
  const fail = (msg) => {
    throw new Error(`${msg}\n\n${USAGE}`);
  };
  const positional = [];
  const opts = { scopeTokens: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v == null) fail(`missing value for ${arg}`);
      i += 1;
      return v;
    };
    if (arg === "--kind") opts.kind = value();
    else if (arg === "--radius") opts.radius = value();
    else if (arg === "--help" || arg === "-h") return null;
    else if (arg === "--scope-token") {
      const v = value();
      const eq = v.indexOf("=");
      if (eq <= 0) fail(`--scope-token expects <token>=<vscode-scope>, got "${v}"`);
      opts.scopeTokens[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (arg.startsWith("--")) fail(`unknown flag "${arg}"`);
    else positional.push(arg);
  }
  if (positional.length !== 3) fail(`expected <theme.json> <id> "<Label>", got ${positional.length} argument(s)`);
  const [themePath, id, label] = positional;
  if (!/^[a-z0-9-]+$/.test(id)) fail(`id must be kebab-case ([a-z0-9-]), got "${id}"`);
  if (label.includes('"')) fail("label must not contain double quotes (it is written into lib/themes.ts)");
  if (opts.kind != null && opts.kind !== "dark" && opts.kind !== "light")
    fail(`--kind must be dark or light, got "${opts.kind}"`);
  if (opts.radius != null && !/^[0-9.]+(rem|px|em|%)$/.test(opts.radius))
    fail(`--radius must be a CSS length like 0.5rem, got "${opts.radius}"`);
  return { themePath, id, label, ...opts };
}

function printReport(mapped) {
  if (mapped.derivations.length > 0) {
    console.log(`\nderivations (${mapped.derivations.length}):`);
    for (const d of mapped.derivations) console.log(`  ${d.token.padEnd(26)} ${d.rule}`);
  } else {
    console.log("\nderivations: none — every token came from its first-choice scope");
  }
  if (mapped.overrides.length > 0) {
    console.log(`\nscope-token overrides (${mapped.overrides.length}):`);
    for (const o of mapped.overrides) console.log(`  ${o.token.padEnd(26)} ← ${o.scope} (${o.value})`);
  }
  if (mapped.notes.length > 0) {
    console.log(`\nnotes (${mapped.notes.length}):`);
    for (const n of mapped.notes) console.log(`  ${n}`);
  }
}

function main(argv) {
  const parsedArgs = parseArgs(argv);
  if (!parsedArgs) {
    console.log(USAGE);
    return;
  }
  const { themePath, id, label, kind, radius, scopeTokens } = parsedArgs;
  const themeJson = parseJsonc(readFileSync(themePath, "utf8"));
  const mapped = mapTheme(themeJson, { kind, radius, scopeTokens });

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cssPath = path.join(root, "app", "themes", `${id}.css`);
  writeFileSync(cssPath, renderThemeCss({ id, label, source: themePath, mapped }));

  const registryPath = path.join(root, "lib", "themes.ts");
  const registry = insertRegistryEntry(readFileSync(registryPath, "utf8"), { id, label, kind: mapped.kind });
  writeFileSync(registryPath, registry.text);

  const globalsPath = path.join(root, "app", "globals.css");
  const imports = updateGlobalsImports(readFileSync(globalsPath, "utf8"), registryOrder(registry.text));
  const globals = extendDarkVariant(imports.text, id, mapped.kind);
  writeFileSync(globalsPath, globals);

  console.log(
    `wrote ${path.relative(root, cssPath)} — ${mapped.name ?? id} (${mapped.kind}, ${TOKEN_ORDER.length} tokens)`,
  );
  console.log(
    `lib/themes.ts — entry ${registry.inserted ? `inserted after "${registry.afterId}"` : "updated in place"} (${mapped.kind})`,
  );
  console.log(
    `app/globals.css — @import after ${imports.after ? `"${imports.after}"` : "nova"}${
      mapped.kind === "dark" ? " + @custom-variant dark entry" : ""
    }`,
  );
  printReport(mapped);
}

// Library when imported (tests), CLI when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`import-theme: ${err.message}`);
    process.exitCode = 1;
  }
}
