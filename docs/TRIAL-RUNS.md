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

### Run 2 (iteration 1) — 2026-10-09 17:50–21:43 (post-0035/0036, deployed 1f56204) — CANCELLED at verify

- Chat `c_Wny2BY-RAJDUYCDM8-8fQ3dH`, run `mr_mv19qa6zdfce77`. Triggered by
  Glen via the chat API; brief wrongly asserted "first run, bootstrap the
  setup" (a gpl setup had existed since Oct 8 — only minio was missing)
  → the plan carried a bootstrap section → the "# Project" preview
  readiness line (PR #60).
- Wall: 3h52m end-to-end, of which 1h38m was Chad's gate wait — **2h14m
  of machine time**: chat→run 7m · plan 3m23s (13 steps) · implement
  21m15s (171 steps) · verify **1h42m (220 steps, cancelled)**.
- What worked: declared services (postgres+minio siblings, zero
  hand-building); setup upgraded and SAVED (future runs one-shot); real
  browser QA on a live preview; **3 screenshots attached** (before /
  after / narrow viewport, served from /api/attachments); clean one-file
  diff; test gate passed cached; high plan quality ($PORT, DEV_AUTO_LOGIN,
  before-shot on unmodified code).
- Why verify ran away: **evidence doesn't cross stages** — the brief
  carries outcome text, not the screenshots, so verify re-audited the
  whole environment (142 of 196 calls env/data checks; 37+ writes
  rejected by pi's workspace rule — /tmp churn that read as "stuck").
- Also found: one typo'd inspect id killed the entire wake turn
  (thrown error, 4 useless retries, no plan summary in the chat);
  179 implement round-trips at ~7s — 53 were one agent-browser
  subcommand each, 3 were --help discovery.
- Fixes in the post-mortem batch (this PR): evidence rides the brief;
  verify scoped (diff + gate + ONE spot-check; cold preview restart =
  the environment test); workspace rule in # Workspace; inspect
  value-shaped errors; agent-browser skill baked into the image
  (rebuild required).
- Prediction for iteration 2: plan ~3m, implement ~8–10m, verify ~3–4m.

### Run 3 (iteration 2) — 2026-10-09 21:52–23:15 (post-#60/#61, deployed 604412f) — CANCELLED at verify

- Chat `c_3a6x4S43YRhuqHiD4LhRgXVX`, run `mr_mv1i9bqhcdec4a`. Clean brief:
  ticket + constraints only. Fresh sandbox (cold start on the clock).
- plan **2m44s / 10 steps** (predicted ~3m ✓ — and this time zero
  bootstrap prose: the "# Project" preview line did its job).
- implement **13m25s / 133 steps** (run 2: 21m15s / 171 — 37% faster;
  prediction was 8–10m, partial credit: 62 browser commands vs 53, the
  skill helped but batching didn't fully land).
- verify **47m+ / 248+ steps, cancelled — NEW failure mode**: the old
  env re-audit is dead (1 get_preview_setup, 1 start_preview), but the
  live spot-check hit a login wall (setup env verified fine —
  DEV_AUTO_LOGIN present; likely a transient/origin bounce) and pi
  spent 163 of 248 calls investigating the app's auth internals
  (login-form.tsx, sessions) instead of reporting the blocker.
- Fix (one variable): verify's stop rule — a blocked spot-check is a
  FINDING; retry ≤2, attach what you saw, name the blocker, never dig
  into app internals to get past it. Candidate for a later iteration,
  one variable at a time: the verify stage's model (flash is
  rabbit-prone; claude stayed sane in implement).
- Chat's wake turn survived (no inspect kills — value-shaped errors
  work); gate approval went through first try.

### Iteration 3 — the simple arm (planned)

Runs the same WYC-1589 ticket through the new `flow` machine: ONE agent
stage with the whole thread (subagent harnesses for implementation,
self-verification, evidence attached) + the PR gate + publish. Zero
context handoffs — the hypothesis (Chad, 2026-10-09) is that the
staged machine's handoff losses were the whole cost, so the simple
shape wins on this ticket class while the staged shape keeps its edge
on big/risky work. The gate now renders the run's attached screenshots
(the eyes are at the gate). Same metrics; prediction: total machine
time under 15 minutes, no verify stage to run away.

## Metrics to keep per run

wall time · Chad's touches (count + minutes) · stage durations + steps ·
QA method (preview vs hand-built) · evidence surfaced (screenshots in
conversation? preview URL?) · deviations/improvisations · frictions
logged.

## Planned comparison

Once the staged (machine) version is tuned, benchmark it against a
simpler arm — a single session that calls harnesses as subagents at
will (Chad, 2026-10-09) — on this same ticket, same metrics. "Simpler
is better" is a hypothesis; the log is the experiment.
