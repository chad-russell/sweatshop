# 0058 — Night shift logo

Status: **approved in chat (2026-10-21).** The owner selected Night shift
from eight logo studies and requested evenly spaced factory windows and
implementation across the app, on the current working branch.

## Design

- Keep the selected sawtooth roof and chimney. The three 12-unit square
  windows have equal 9.5-unit horizontal gutters, including the outer
  margins, within the factory's 74-unit width.
- `public/logo.svg` is the canonical transparent mark. The UI displays it
  as a CSS mask, so semantic text colors work across every app theme.
- Keep the existing live monospace name alongside the mark in the sidebar
  (including its mobile drawer). Use the same mark in the empty chat view.
- Use the same browser SVG beside the repository README title.
- Browser icons use the default theme's yellow mark on a near-black square
  for consistent contrast against browser chrome. Supply an SVG icon, a
  legacy ICO with 16/32/48px images, and a 180px Apple touch icon through
  Next.js's built-in metadata file conventions. These are static exports
  from the canonical SVG; they require no new runtime or dependency.
- Contextual navigation, harness/provider marks, and conversation action
  icons keep their existing meaning. Night shift represents the app itself.

## Verification

Inspect the corrected gutters, 16/24/32px symbols, desktop sidebar, empty
chat, mobile drawer, and light/dark themes. Verify the generated icon files
and metadata links. Run the container typecheck, lint, and test gates
before committing.

The logo and empty state were inspected in a static component fixture with
the compiled app stylesheet, in clickhouse and cal at 1120px and at small
icon sizes. The SVG/ICO/PNG exports were checked for matching geometry and
the expected dimensions. Typecheck and lint passed (two existing unused
import warnings); tests passed: 1,076 tests, with 16 opt-in tests skipped.
