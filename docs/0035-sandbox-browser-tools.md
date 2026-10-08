# 0035 — Browser tools in sandbox images (agent-browser)

Status: **draft 2026-10-08 — decision (Chad): baked into sandbox images
for general-purpose use, "anything it needs" — not a QA-only tool.**
Pulls the browser + screenshot slice of roadmap 3.1 forward; artifact
hosting stays in 3.1.

## What

[Vercel Labs agent-browser](https://github.com/vercel-labs/agent-browser)
(npm `agent-browser`; Rust CLI, headless Chromium, compact agent-facing
output) plus a headless Chromium, baked into `Containerfile.sandbox` at
image build — nothing downloads at runtime. The agent drives it from
bash like any CLI: navigate, click, fill, extract, screenshot — for its
own QA, scraping, or walking a flow. Chosen over a hand-rolled
playwright wrapper per the vercel-ecosystem preference (AGENTS.md).

## Wrinkles the implementation settles

- **Image contract**: browser presence is documented in the 0014 image
  contract; a custom `image_ref` without it degrades to
  not-installed — agent-checkable (`command -v agent-browser`), not a
  tool gate.
- **Reachability spike**: `pv-*.internal.crussell.io` from inside
  `sweatshop-harness` (bees' caddy → 10.10.0.12:3301 → preview proxy →
  sibling container). Verify DNS + TLS from a sandbox before relying on
  it; sandbox-localhost targets work natively (the reason it lives in
  the image).
- **Attach path**: PNGs land anywhere under `/work`; a thin
  `screenshot` convention records one as an image part in the
  transcript (file under `data/`, served by an API route) so "attach it
  when I'm QA-ing" is one call. PR-body inlining waits for 3.1 artifact
  hosting; interim = transcript card + preview link.

## Non-goals

An app-container browser (rejected — general-purpose use argues for
in-sandbox); egress policy; artifact/HTML hosting (3.1).
