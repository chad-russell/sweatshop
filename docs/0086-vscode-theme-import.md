# 0086 — VSCode theme importer

Status: proposed. Branch `glen/vscode-theme-importer`. Delivers the
DESIGN.md north star ("import any VSCode theme and use it as an app
theme") as a CLI that writes the same files a hand-made theme uses.

## Why

0044 built the registry and left the importer as "groundwork". Rather
than hand-crafting every new scheme, we adopt the VSCode workbench color
schema as the import format: the largest theme catalog on earth (Marketplace
/ open-vsx, all MIT/Apache-friendly metadata), with real UI semantics
(editor, sidebar, widgets, buttons, status colors) plus terminal ANSI —
unlike Ghostty (16 ANSI colors, no UI semantics) or tmTheme (syntax
scopes only). An imported theme is indistinguishable from a hand-made
one: same registry entry, same token-complete CSS file, same tests.

## Shape

`scripts/import-theme.mjs` — zero dependencies, run by hand:

```
node scripts/import-theme.mjs design/<dir>/<theme>.json <id> "<Label>" \
  [--kind dark|light] [--radius 0.5rem] [--accent-color <scope>]
```

The JSON source is vendored into `design/<id>/` (with the upstream
LICENSE) so imports are reproducible and reviewable. The importer:

1. Parses the theme (JSONC-tolerant: comments, trailing commas).
2. Maps workbench colors onto the token contract (table below).
3. Flattens any `#rrggbbaa` alpha to opaque over the theme background.
4. Writes `app/themes/<id>.css` (tokens only, header comment with source
   + derivation notes).
5. Inserts the registry entry (after the last dark/light theme of its
   kind), the `globals.css` import (after nova), and — for dark themes —
   extends the `@custom-variant dark` list.
6. Prints a derivation report; **missing core colors are a hard error**,
   derivations are listed for the curation pass (0044's rule: never
   silently omit).

## Scope → token mapping

| token | first choice | fallback chain (in order) | derivation if all absent |
|---|---|---|---|
| background | editor.background | editorGutter.background | **error** |
| foreground | editor.foreground | | **error** |
| card | editorWidget.background | dropdown.background, sideBar.background | background lifted 1 step |
| card-foreground | editorWidget.foreground | dropdown.foreground, foreground | foreground |
| popover | dropdown.background | editorWidget.background, quickInput.background | card lifted 1 step |
| popover-foreground | dropdown.foreground | editorWidget.foreground, foreground | foreground |
| primary | button.background | focusBorder, accent (custom), activityBarBadge.background | focusBorder |
| primary-foreground | button.foreground | | contrast pick (ink/bg by YIQ) |
| secondary | secondaryButton.background | button.background dimmed 25% onto bg | input.background |
| secondary-foreground | secondaryButton.foreground | | foreground |
| muted | sideBar.background | editorGroupHeader.noTabsBackground, panel.background | background dimmed 4% |
| muted-foreground | descriptionForeground | sideBar.foreground, foreground 60% | foreground dimmed |
| accent | list.hoverBackground (flattened) | list.activeSelectionBackground | muted lifted 1 step |
| accent-foreground | list.hoverForeground | list.activeSelectionForeground, sideBar.foreground, foreground | foreground |
| destructive | editorError.foreground | | **error** |
| destructive-foreground | button.foreground | | contrast pick |
| border | panel.border | widget.border, editorGroup.border, contrastBorder | muted lifted 1 step |
| input | input.background | | secondary |
| ring | focusBorder (alpha ≥50% kept) | accent, focusBorder flattened | primary |
| chart-1..5 | terminal blue/green/yellow/magenta/red (ANSI order for visual spread) | | — |
| sidebar | sideBar.background | activityBar.background | background dimmed 2% |
| sidebar-foreground | sideBar.foreground | | foreground |
| sidebar-primary | activityBarBadge.background | accent, focusBorder | primary |
| sidebar-primary-foreground | activityBar.foreground | | contrast pick |
| sidebar-accent | list.inactiveSelectionBackground | sideBarSectionHeader.background | accent |
| sidebar-accent-foreground | sideBarSectionHeader.foreground | list.hoverForeground | accent-foreground |
| sidebar-border | sideBar.border | panel.border, contrastBorder | border |
| sidebar-ring | focusBorder | | ring |
| success | editorInfo.foreground | terminal.ansiGreen, editorHint.foreground | terminal.ansiGreen |
| warning | editorWarning.foreground | terminal.ansiYellow | terminal.ansiYellow |
| info | terminal.ansiBlue (always present) | editorInfo.foreground | — |
| radius | `--radius` flag | | 0.5rem |
| terminal | terminal.background | editor.background | background |
| terminal-foreground | terminal.foreground | | foreground |
| terminal-muted | descriptionForeground | terminal.ansiBrightBlack | muted-foreground |
| terminal-border | panel.border | widget.border | border |
| terminal-red..cyan | terminal.ansiRed..ansiCyan (bright variants when present) | | **error** (core) |
| terminal-black | terminal.ansiBlack | | **error** (core) |
| terminal-white | terminal.ansiBrightWhite | terminal.ansiWhite | |
| terminal-ink | terminal.foreground if dark-on-light else terminal.background | | background |
| terminal-bg-* | terminal.ansiBright* (bright in every theme: text on them is terminal-ink) | terminal.ansi* | |

"lifted/dimmed N%" = oklab lightness shift away from/toward background,
clamped; "contrast pick" = the darker of ink/bg pair by YIQ against the
surface.

Notes:
- `info` prefers ANSI blue over editorInfo.foreground when both exist
  and editorInfo is ~invisible on background (Tokyo Night's is a cyan
  that reads fine — the rule is: use editorInfo unless its contrast
  against background is below 3:1, then fall back to ANSI blue).
- Dracula maps editorWarning → cyan `#8BE9FD`, unusable as warning;
  override via `--warning-scope terminal.ansiYellow` style flags at
  import time (documented in the report).
- `terminal-ink` follows the repo convention: bg-ANSI colors are bright,
  the ink drawn on them is the theme's terminal background.

## First batch (all MIT, vendored with licenses)

| id | label | source | vendored from |
|---|---|---|---|
| catppuccin | Catppuccin Mocha | Catppuccin/catppuccin-vsc 3.19.0 | design/catppuccin/mocha.json |
| dracula | Dracula | dracula-theme/theme-dracula 2.25.1 | design/dracula/dracula.json |
| tokyo-night | Tokyo Night | enkia/tokyo-night 1.1.2 | design/tokyo-night/tokyo-night.json |
| rose-pine-moon | Rosé Pine Moon | mvllow/rose-pine 2.15.2 | design/rose-pine-moon/rose-pine-moon.json |

All four define complete 16-color ANSI sets. Known gaps the derivations
cover: Mocha/Rosé Pine lack terminal.background (→ editor.background);
Dracula lacks editorInfo.foreground (→ terminal.ansiBlue) and uses cyan
as editorWarning (→ ansiYellow #F1FA8C); Tokyo Night's focusBorder is
#545c7e33 (20% alpha — flattened it's near-invisible; ring falls back to
list.activeSelectionBackground/accent).

## What the importer does NOT do

- No runtime import, no user upload UI, no new app dependency. Import is
  a dev-time curation step; output is committed and reviewed.
- No syntax-token mapping (tokenColors/scope) — the app doesn't render
  code syntax today; if it does, the importer grows a second table.
- No light/dark pairing: each VSCode variant is its own registry entry
  (0044 decision).

## Tests

- themes.test.ts already enforces completeness/registry/import wiring
  for imported themes exactly as for hand-made ones.
- New: importer unit test — fixture JSON in tests/fixtures, run the
  mapping (exported from the script), assert the generated CSS contains
  every contract token and the expected derivations (alpha flattening,
  warning-override, contrast pick).
