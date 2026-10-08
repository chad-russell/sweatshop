# Demo week friction log

One line per annoyance, newest last, while working in sweatshop
instead of dsh (GPL, 2026-10-08 →). This file drives Phase 2/3
ordering — record it even when it's small, especially when it sent
you back to dsh.

Format: `- [date] surface — what frictions; (what you did instead)`

## Log

- [2026-10-08] clean slate — deleting the spike project 500'd (FK bug,
  PR #44); first real data-loss-class bug found by the demo prep.
- [2026-10-08] clean slate, round 2 — the delete then failed on
  sandboxes bound to NULL-project e2e chats (PR #46: unbind instead
  of fail). Lesson: SQL `!=` hides NULLs from every "who references
  this" probe.
- [2026-10-08] GPL setup — the setup chat couldn't find the private
  repo (no gh/credential powers) or create the project (no tool); the
  agent asked correctly via ask_chad but offloaded UI work + ids to
  Chad. → 0033: gh discovery (Phase A) + project tools (Phase B).
- [2026-10-08] git — no PR gate: create_pr executed silently; worse,
  sandboxes held the full PAT, so bash could push main/develop with no
  backstop. → 0034: gated create_pr, read-scoped sandbox creds,
  brokered git_push, host branch protection.
- [2026-10-08] QA — no browser: verifying UI work meant Chad opening
  previews himself; nothing to screenshot and attach. → 0035:
  agent-browser + chromium in sandbox images, screenshot attach.
