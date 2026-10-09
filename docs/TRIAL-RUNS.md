# Trial-week run history — WYC-1589 (enlarge the product preview)

One row per retry of the same ticket, oldest first, so each run can be
compared against the last and the loop's direction is visible: fewer of
Chad's touches, less wall time, QA evidence in the conversation, no
hand-built environments. Ground truth lives in the app (conversation +
run + harness events); this file is the comparison layer — durations
are UTC, measured from the DB rows.

## Runs

### Run 1 — 2026-10-09 01:51–02:11 (baseline, pre-0035/0036)

- Chat `c_Qp-y6L38ZKD_mOsn9MYkm`, run `mr_mv0bab3za6d6d8` (machine
  `ticket`), GLM flash chat + pi plan/verify + claude implement.
- Wall: **17m52s** ask→pushed. Chad's touches: 50s project answer
  (ask_chad) + 1m43s plan approval + reading the report. 2 interrupts.
- Stages: plan 2m51s (9 steps) · gate 1m43s · implement 6m28s (52
  steps) · verify 2m12s (8 steps) · pr-approve cancelled by the agent.
- QA: **hand-built** — apt postgres, hand-rolled S3 stub, playwright +
  chromium installed at runtime, dev server invisible to sweatshop
  (5 of 6.5 implement minutes). Screenshots existed only in sandbox
  /tmp; the conversation could name their paths.
- Outcome deltas: no push-only machine outcome (cancel-at-gate
  improvisation; pr_proposals row dangles pending); remote branch
  pushed manually by the chat (later deleted for the retry series).
- Findings → docs/0035, docs/0036, TRIAL-FRICTION 2026-10-09 entries.

### Run 2 (iteration 1) — 2026-10-09 17:50→ (post-0035/0036, deployed 1f56204)

- Chat `c_Wny2BY-RAJDUYCDM8-8fQ3dH`, run `mr_mv19qa6zdfce77`.
- Prompted by Glen via the chat API (fresh chat, project gpl) — brief
  carried a wrong "first run, bootstrap the setup" assertion (a gpl
  preview setup had existed since Oct 8; only minio was missing), so
  the plan spent a bootstrap section obeying it → the "# Project"
  brief line on preview readiness followed (this PR).
- Plan: 13 steps, 3m11s — read `system_docs` first; planned declared
  services, $PORT-honoring command, DEV_AUTO_LOGIN, before/after
  screenshots on the unmodified preview + a narrow-viewport shot,
  minio bucket + seeded asset, screenshots attached. (Fill in the rest
  when the run settles.)

## Metrics to keep per run

wall time · Chad's touches (count + minutes) · stage durations + steps ·
QA method (preview vs hand-built) · evidence surfaced (screenshots in
conversation? preview URL?) · deviations/improvisations · frictions
logged.
