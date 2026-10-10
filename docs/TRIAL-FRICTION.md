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
- [2026-10-08] GPL setup, take 2 — create_project's approval existed
  only in /inbox; the transcript card had no buttons and looked
  stalled. → in-transcript approval cards for gated tools. Related
  backlog (Chad): a default sandbox for every chat, so the
  sandbox/no-sandbox tool split stops biting.
- [2026-10-08] git — no PR gate: create_pr executed silently; worse,
  sandboxes held the full PAT, so bash could push main/develop with no
  backstop. → 0034: gated create_pr, read-scoped sandbox creds,
  brokered git_push, host branch protection.
- [2026-10-08] QA — no browser: verifying UI work meant Chad opening
  previews himself; nothing to screenshot and attach. → 0035:
  agent-browser + chromium in sandbox images, screenshot attach.
- [2026-10-09] first ticket (WYC-1589) — "do the work, push the branch,
  no PR" is not a machine outcome: the chat improvised cancel-at-gate
  + a manual bash push, so the run reads cancelled and the
  pr_proposals row dangles pending forever. → deferred (Chad): gates
  already wait indefinitely; revisit after preview-driven QA lands.
- [2026-10-09] QA env — the implement stage built its own world (apt
  postgres, hand-rolled S3 stub, playwright+chromium install, dev
  server invisible to sweatshop): 5 of 6.5 implement minutes, no
  reuse of the 0016/0017 substrate. → 0036 (to draft): QA stages run
  through start_preview + the project's saved setup/services; iterate
  from a chat attached to the preview's sandbox.
- [2026-10-09] QA evidence — real before/after screenshots existed in
  the sandbox /tmp; the conversation could only name their paths.
  → 0035 attach path (inline image parts); artifacts long-term (3.1).
- [2026-10-09] inspect — the run result's hint says "inspect a visit's
  session id (mr_…_<seq>)" but inspect only knows conversations rows,
  so harness stage sessions FatalError mid-turn (chat fell back to
  bash+grep). → teach inspect stage session ids, or fix the hint.
- [2026-10-09] harness_runs — tool_calls is always 0 on machine-stage
  visits (endHarnessSession re-reads the zero claimHarnessRun wrote
  instead of counting events). → count from harness_events.
- [2026-10-09] chat context — a plain chat that start_machines on a
  project gets bound to that project's sandbox for life (0013), and
  the project itself had to be asked (50s ask_chad round-trip).
  → composer project defaults; maybe warn on cross-project binding.
- [2026-10-09] backlog — the thinking picker was finished and
  spike-verified but unmerged (#54), so to the user it "didn't exist";
  three PRs went stale during trial prep. → merge discipline: land
  small PRs the same day during trial weeks.
- [2026-10-09] run 2 — the wake turn DIED on a typo'd inspect id
  (thrown error retried 4x, then bubbled: no plan summary in the chat).
  → inspect returns value-shaped unknown-id errors; ids come from the
  runEvent metadata, never retyped.
- [2026-10-09] run 2 — verify re-audited the whole environment for
  1h42m because evidence doesn't cross stages (outcome text only).
  → attachments ride the brief; verify scoped to diff + gate + one
  spot-check; a cold preview restart IS the environment test.
- [2026-10-09] run 2 — pi ground against the /tmp workspace rule (37+
  rejected writes; the transcript looked frozen). → the rule is stated
  in the brief's # Workspace section.
- [2026-10-09] run 2 — 391 model round-trips; 53 were one
  agent-browser subcommand each, learned via --help. → the CLI's skill
  is baked into the sandbox image (refs + batch patterns).
- [2026-10-09] run 3 — verify chased a login wall into the app's auth
  internals for 47m (163 of 248 calls) instead of reporting the blocker.
  → stop rule in the verify seeds: a blocked spot-check is a finding;
  retry ≤2, screenshot the blocker, never dig into app internals.
- [2026-10-10] run 4 — the gate card showed no screenshots: evidence
  collection only scans harness visits; the flow machine's agent-stage
  attachments live in its stage conversation. → collectRunEvidence (and
  the brief's evidence) must read agent-stage tool results too.
- [2026-10-10] run 4 — REAL setup bug found and worked around: the gpl
  preview setup's BETTER_AUTH_URL points at the preview host, forcing
  SSO with no email fallback off-localhost (run 3's 47m verify spiral
  was this). → fix the saved setup env (or default auth to the dev
  auto-login for previews).
- [2026-10-10] run 4 — agent-stage visits report steps=0 and persist
  only at visit end: fine to run, blind to monitor. → wire the steps
  counter and consider incremental persistence or live-stream parity
  with harness stages.
- [2026-10-10] run 5 — the create_pr card said "Screenshots: none"
  although the thread had attached 3: a turn persists only at its end,
  and the card is built mid-turn. → the evidence collector must also
  read the live turn's messages.
- [2026-10-10] run 5 — the gpl preview served HTML but React never
  hydrated through the preview host (empty `__next_f`). The thread spent
  ~20 min on it, plus 20 calls hand-minting an auth session in postgres
  (the BETTER_AUTH_URL bug again). → fix the gpl setup env; investigate
  hydration through the preview proxy.
- [2026-10-10] run 5 — the playbook's stop rule ("retry ≤ 2, report the
  blocker") was ignored. Advice in a prompt is not a guarantee. → if it
  recurs, a runtime guard (e.g. budget-per-blocked-check), not more
  prose.
- [2026-10-10] run 5 — chat turns persist only at turn end, so a 30-min
  playbook turn is invisible to DB monitoring (same blind spot as agent
  stages); only the live stream shows progress. → incremental
  persistence per slice.
- [2026-10-10] run 5 follow-up — ROOT CAUSES found: (1) Next 16 dev
  blocks `/_next/webpack-hmr` from non-localhost origins without
  `allowedDevOrigins`, so the page renders but never hydrates (same
  behaviour via the container IP; works at localhost); (2) gpl turns on
  email/auto-login only when `BETTER_AUTH_URL` is localhost. → agents QA
  at `http://localhost:$PORT` (ship playbook + docs/agent/previews.md);
  the gpl setup keeps auth on localhost and passes
  `ALLOWED_DEV_ORIGINS=${PREVIEW_HOST}` /
  `BETTER_AUTH_TRUSTED_ORIGINS=${PREVIEW_URL}` (saved); Chad-facing
  previews need the neutral gpl change (TangoGroup/360-gpl#45, draft).
  Verified live: localhost hydrates + auto-logs-in on unpatched gpl
  main; the preview URL does too with #45 applied.
