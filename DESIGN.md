# DESIGN.md — sweatshop

Sweatshop's operative design contract. When building or changing UI, follow
this file; the vendored analyses under `design/` are the references each
theme was derived from.

## Themes

A theme is a complete set of CSS custom properties under
`[data-theme="<id>"]` in `app/themes/<id>.css` (imported by
`app/globals.css`), selected at runtime via the `data-theme` attribute
(persisted by next-themes). The registry — which themes exist, their labels
and dark/light kind — is `lib/themes.ts`; `tests/themes.test.ts` enforces
that registry and CSS never drift (docs/0044). Current themes:

| theme        | feel                                              | source                          |
| ------------ | ------------------------------------------------- | ------------------------------- |
| `clickhouse` | **default.** Near-black canvas, electric yellow `#faff69`, hairlines, tight radii (0.5rem) | `design/clickhouse/DESIGN.md` |
| `everforest` | medium-dark greens, sage primary `#a7c080`, soft radii | Everforest (sainnhe)      |
| `nord`       | polar night `#2e3440`, frost blue primary `#88c0d0`, soft radii | Nord (arcticicestudio) |
| `gruvbox`    | warm retro groove, yellow primary `#fabd2f`, 0.5rem radii | Gruvbox (morhetz)         |
| `cal`        | clean white canvas, black CTAs, hairlines, soft 12px radii, blue focus | `design/cal/DESIGN.md` |
| `nova`       | shadcn baseline light (fallback + regression baseline) | shadcn default palette       |
| `catppuccin`  | Mocha: pastel dark, mauve primary `#cba6f7`, green success | Catppuccin — imported (0086) |
| `dracula`     | purple canvas `#282a36`, purple primary `#bd93f9`, canonical ANSI | Dracula — imported (0086) |
| `tokyo-night` | blue-black `#1a1b26`, blue primary `#7aa2f7` hues | Tokyo Night — imported (0086) |
| `rose-pine-moon` | violet night `#232136`, rose primary `#ea9a97` | Rosé Pine — imported (0086) |

The token set is shadcn's semantic contract (background, foreground, card,
popover, primary, secondary, muted, accent, destructive, border, input, ring,
chart-1..5, sidebar-*, radius) plus sweatshop's status trio: `success`,
`warning`, `info` — used for event kinds and machine states.

## Rules

The app's logo is **Night shift**, the factory mark in `public/logo.svg`
(0058). Use `SweatshopLogo` with semantic text colors in the UI; keep the
monospace name in the sidebar. `app/icon.svg`, `app/favicon.ico`, and
`app/apple-icon.png` are browser/home-screen exports of that same mark.
The three square windows and their four horizontal gutters stay equal.

1. Components use semantic tokens only (`bg-background`, `text-primary`,
   `border-border`, `text-success`...). **Never raw hex/oklch in TSX.** Any
   rule bend is a token missing from the contract — add the token, not the
   hex.
2. Every theme defines every token. A theme with holes is a broken app.
3. Radius is a token: themes express character through `--radius`
   (clickhouse = tight 6px, cal = soft 12px). Don't hardcode rounded grades
   where the token scale suffices.
4. Monospace is the machine's voice: identifiers, URNs, event kinds, db slugs
   render `font-mono`. Humans get the sans; machines get the mono.

## North star

Import any VSCode theme and use it as an app theme — done (docs/0086):
`node scripts/import-theme.mjs <vendored>.json <id> "<Label>"` maps the
workbench colors onto this token contract and writes the registry entry,
CSS file and wiring; the derivation report is the curation pass. The
rules above are what keep it possible: if the app only ever speaks in
tokens, a theme is just data.
