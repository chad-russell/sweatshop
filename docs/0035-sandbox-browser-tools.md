# 0035 — Browser tools in sandbox images (agent-browser)

Status: **implemented 2026-10-09 — carrying the 2026-10-08 decision
(Chad): baked into sandbox images for general-purpose use, "anything
it needs" — not a QA-only tool.** Pulls the browser + screenshot slice
of roadmap 3.1 forward; artifact hosting stays in 3.1.

## What

[Vercel Labs agent-browser](https://github.com/vercel-labs/agent-browser)
(npm `agent-browser`; Rust CLI, headless Chromium, compact agent-facing
output) plus a headless Chromium, baked into `Containerfile.sandbox` at
image build — nothing downloads at runtime. The agent drives it from
bash like any CLI: navigate, click, fill, extract, screenshot — for its
own QA, scraping, or walking a flow. Chosen over a hand-rolled
playwright wrapper per the vercel-ecosystem preference (AGENTS.md).

## Wrinkles the implementation settled

- **Image contract**: browser presence is documented in the 0014 image
  contract; a custom `image_ref` without it degrades to
  not-installed — agent-checkable (`command -v agent-browser`), not a
  tool gate.
- **`--with-deps` is unusable at build time** (it shells `sudo apt-get`,
  which the image only grants to the sandbox user): the Chrome shared
  libraries are installed explicitly as root — the exact list
  agent-browser itself would install, verified on trixie (t64 package
  renames resolve automatically). `agent-browser install` then runs as
  the sandbox user at build time, putting Chrome for Testing under
  `~/.agent-browser/browsers/` — pinned by the image build; bump the
  CLI pin and rebuild to move. Smoke-tested headless end to end in the
  built image (open → screenshot → valid PNG as the sandbox user).
- **Reachability spike**: `pv-*.internal.crussell.io` from inside
  `sweatshop-harness` (bees' caddy → 10.10.0.12:3301 → preview proxy →
  sibling container). Verify DNS + TLS from a sandbox before relying on
  it; sandbox-localhost targets work natively (the reason it lives in
  the image).
- **Attach path**: `attach_screenshot` (chats, agent stages, harness
  stages — the same shared definition) copies a sandbox PNG (any path
  in the container, PNG-only, ≤ 10 MiB, magic-checked) to
  `data/attachments/att_<hex>.png` and returns its `/api/attachments/…`
  URL; the transcript renders it as an image card (click to open full
  size). The route serves immutably; `ATTACHMENTS_DIR` relocates the
  root. PR-body inlining waits for 3.1 artifact hosting; interim =
  transcript card + preview link.

## Non-goals

An app-container browser (rejected — general-purpose use argues for
in-sandbox); egress policy; artifact/HTML hosting (3.1).
