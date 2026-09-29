# DESIGN.md — sweatshop

Sweatshop's operative design contract. When building or changing UI, follow
this file; the vendored analyses under `design/` are the references each
theme was derived from.

## Themes

A theme is a complete set of CSS custom properties under
`[data-theme="<name>"]` in `src/app/globals.css`, selected at runtime via the
`data-theme` attribute (persisted by next-themes). Current themes:

| theme        | feel                                              | source                          |
| ------------ | ------------------------------------------------- | ------------------------------- |
| `clickhouse` | **default.** Near-black canvas, electric yellow `#faff69`, hairlines, tight radii | `design/clickhouse/DESIGN.md` |
| `cal`        | clean white canvas, black CTAs, hairlines, soft 12px radii, blue focus | `design/cal/DESIGN.md`        |
| `nova`       | shadcn baseline light (fallback + regression baseline) | shadcn default palette       |

The token set is shadcn's semantic contract (background, foreground, card,
popover, primary, secondary, muted, accent, destructive, border, input, ring,
chart-1..5, sidebar-*, radius) plus sweatshop's status trio: `success`,
`warning`, `info` — used for event kinds and machine states.

## Rules

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

Import any VSCode theme and use it as an app theme. The rules above are what keep
that possible: if the app only ever speaks in tokens, a theme is just data.
