# 0044 — Theme registry and color schemes

Status: implementing (branch `glen/theme-color-schemes`). Expands the
DESIGN.md theming contract from three inline themes to a registry-backed
set with per-theme CSS files, and adds three color schemes: everforest,
nord, gruvbox (all dark). Lays the groundwork for the north star —
importing any VSCode theme — without building the importer yet.

## Why

DESIGN.md's north star is "import any VSCode theme and use it as an app
theme". Three things blocked that:

1. Themes lived inline in one 378-line `app/globals.css`; adding one
   meant editing a shared file with no enforced completeness.
2. The theme list was a const inside `components/theme-provider.tsx`,
   duplicated from CSS by hand.
3. Nothing enforced DESIGN rule 2 ("every theme defines every token") —
   a theme with holes is a broken app.

## The registry

`lib/themes.ts` — `THEMES: readonly ThemeEntry[]`, `{ id, label, kind }`
where `kind` is `"dark" | "light"`. Everything that needs the list reads
this: the provider (next-themes `themes` prop), the picker, and the
completeness test. `id` doubles as the `[data-theme]` value and the CSS
file name (`app/themes/<id>.css`).

Adding a theme:
1. Add one entry to `THEMES`.
2. Add `app/themes/<id>.css` with a complete token set (copy a sibling).
3. Import it from `app/globals.css`.

`tests/themes.test.ts` fails if the two halves drift: every registry id
must have a CSS file whose `[data-theme="<id>"]` block defines every
contract token, and every CSS theme block must have a registry entry.

## The token contract (complete list)

One `--radius`, plus:

- shadcn semantic: background, foreground, card(-foreground), popover(-foreground),
  primary(-foreground), secondary(-foreground), muted(-foreground),
  accent(-foreground), destructive(-foreground), border, input, ring,
  chart-1..5, sidebar(-foreground, -primary(-foreground), -accent(-foreground),
  -border, -ring)
- sweatshop status trio: success, warning, info
- brand constant: brand-claude (same in every theme)
- terminal surface + ANSI: terminal, terminal-foreground, terminal-muted,
  terminal-border, terminal-{red,green,yellow,blue,magenta,cyan}, and the
  ANSI black/white fg + 8 background colours (terminal-ink, terminal-bg-*)

`--content-max` is NOT a theme token (layout, defined once in :root).

## New schemes

| theme       | source                          | character                                   |
| ----------- | ------------------------------- | ------------------------------------------- |
| everforest  | Everforest (sainnhe), medium-dark | muted green fg, sage primary #a7c080      |
| nord        | Nord (arcticicestudio)          | polar night bg #2e3440, frost primary #88c0d0 |
| gruvbox     | Gruvbox (morhetz), dark         | warm contrast, yellow primary #fabd2f     |

All three ship canonical terminal ANSI palettes — the terminal surfaces
get real scheme colors instead of defaults. Radii: everforest/nord
0.625rem, gruvbox 0.5rem (chunkier personality), clickhouse bumped
0.375 → 0.5rem (still the tightest theme; it was reading too square).

## VSCode-theme mapping sketch (importer groundwork)

> Superseded by docs/0086's exact mapping table — the importer landed.

When the importer arrives it reads a VSCode theme JSON's token scopes and
writes the same CSS files. First-cut scope → token mapping (the importer
must treat every unmapped token as an error, never silently omit):

| sweatshop token          | VSCode scope (fallback chain)                              |
| ------------------------ | ----------------------------------------------------------- |
| background               | editor.background → editorGutter.background                 |
| foreground               | editor.foreground                                           |
| primary                  | focusBorder / accent* (workbench.colorCustomizations)       |
| border / input           | editorGroup.border / input.border                           |
| muted                    | sideBar.background                                          |
| muted-foreground         | descriptionForeground                                       |
| card / popover           | editorWidget.background / dropdown.background               |
| terminal-*               | terminal.ansi* (direct: red, green, yellow, blue, magenta, cyan, black, white, background, foreground) |
| sidebar                  | sideBar.background / sideBarSectionHeader.background        |
| destructive              | editorError.foreground                                      |
| success / warning / info | editorInfo / editorWarning / editorHint .foreground         |
| ring                     | focusBorder                                                 |
| --radius                 | not a VSCode concept — theme author's choice, default 0.5rem |

VSCode themes define syntax scopes, not UI semantics; every import is a
curation pass over this table. That is why the registry came first: an
imported theme is just another entry + file, identical to a hand-made one.

## Decisions

- **Per-theme CSS files over one growing globals.css**: reviewable diffs,
  mechanical import, and the importer writes standalone files.
- **Dark-only for the three new schemes**: each upstream has a light
  variant; they can be added as separate registry entries later (`gruvbox-light`).
- **kind is metadata, not behavior**: next-themes keeps single-theme
  selection (no system/dark-mode switching yet). `kind` exists so a future
  mode-aware default can group the picker and the importer can label its
  output.
- **Dropdown picker over the cycler**: at 6 themes the cycler's
  cost-per-switch is too high (the toggle component's own comment
  anticipated this).
