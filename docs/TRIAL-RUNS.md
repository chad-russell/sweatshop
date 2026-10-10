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

### Run 4 (iteration 3, the simple arm) — 2026-10-10 00:37–00:48 (flow machine, deployed 76469b6) — COMPLETED

- Chat `c_2MmkqeVTq8qy_69J-e20QizB`, run `mr_mv1o1tfu4dbffd`, machine
  `flow` (first flight). Same ticket, same clean brief, fresh sandbox.
- **10m30s wall** (chat preamble ~1m, work stage 9m27s), **one gate
  decision** (Chad rejected — the no-PR choice per the brief; run ended
  cleanly). Zero runaways, zero improvisation.
- **Best engineering of all four runs**: found the REAL root cause the
  three staged runs missed (base `DialogContent` carries `sm:max-w-lg`;
  tailwind-merge can't dedupe across variant prefixes → the dialog was
  capped at 512px, not 896) and fixed both variants, with a 375px
  responsive check. Tests 235/235.
- **Hit run 3's login wall and handled it as a footnote**: diagnosed
  `BETTER_AUTH_URL` pointing at the preview host (forces SSO, no
  email fallback off-localhost), restarted the preview with env
  overrides for seeded auto-login. That is a REAL setup bug now
  identified — fix pending.
- **Zero subagent calls** — glm-flash judged the 4-line CSS fix not
  worth delegating to claude, correctly. The shape let it choose.
- Gaps found: gate card rendered no screenshots (collectRunEvidence
  scans harness visits; the flow stage is an AGENT stage — its
  attachments live in the stage conversation → evidence collection must
  read agent-stage tool results too; same fix feeds stage briefs).
  Agent-stage `steps` counter stays 0 (not wired). Reject leaves the
  pr_proposals row dangling (known since run 1).
- **Verdict for this ticket class: simpler won decisively** — 10.5
  minutes, one touch, best fix, fewest failure modes.

### Run 5 (0037, Ship playbook in a plain chat) — 2026-10-10 03:10–03:50 (deployed 89ffcb6) — WORK DONE, PR declined by design

- Chat `c_t2Y1HqNl6UIHTp6-ptmHJ`, project gpl, `playbook: ship`, GLM
  flash, fresh sandbox. Same ticket and constraints; the only change
  is the ending: `create_pr` on the local branch (its card is the gate)
  instead of propose_pr → gate → publish.
- **Ask → first PR card: 31m22s**, all in ONE turn (156 model steps
  across the whole thread; 0 budget continuations; 0 subagent calls,
  same as run 4). Run 4 took 10m30s to its gate. The 3× is mostly one
  NEW environment problem, not the shape (below).
- **The card did its job.** It was built by the runtime: the test
  command ran in the sandbox (passed, 235/235, 7 s — warm install) and
  the commits + diffstat were read from the checkout. One honest miss:
  the card said "Screenshots: none" even though the thread attached 3
  (before, after, and after-70vh). Cause: the turn persists to
  `messages` only at TURN END, and the card is built mid-turn, so the
  evidence collector cannot see this turn's attachments yet. → fix:
  collect from the live turn's messages (pass them in), not only from
  persisted rows.
- **The revise loop worked — the case `flow` fails.** At the first card
  Chad (via me) typed "use 70vh, add a QA note to the body". The send
  answered the pending approval (`answered`, not steered). create_pr
  returned `changes-requested`, and the SAME turn changed 75vh → 70vh,
  re-shot an AFTER screenshot, rewrote the body, and re-called
  create_pr. Typed revise → second card: **3m41s**, with full context
  and no re-derivation.
- **Engineering:** a smaller root-cause find than run 4 (it fixed
  `max-w-4xl` → `sm:max-w-5xl` without naming the tailwind-merge
  variant collision explicitly, but the effective width still went
  512 → 1024 px), 60vh → 70vh media, tests green.
- **New friction: the preview didn't hydrate.** React never hydrated
  through the preview host (`__next_f` empty in the page while the HTML
  carried the flight payload). The thread spent most of its time here
  (78 agent-browser calls), plus 20 calls minting a session directly in
  postgres to get past auth (the known BETTER_AUTH_URL setup bug). It
  did eventually get real before/after shots. The stop rule ("a blocked
  visual check is a finding; retry ≤ 2") was NOT obeyed — it is advice
  in a playbook, and nothing enforces it. Same class as run 3's spiral,
  now inside one thread.
- Ending: Chad denied the second card on purpose (a work repo; no real
  PR for an experiment) → create_pr `denied` → the thread asked what to
  change (ask_chad) → typed "nothing, stop" answered it → a two-line
  summary. Branch is local only. No dangling rows: every pending input
  resolved.
- **Verdict:** the 0037 mechanics work (one thread; card evidence built
  by the runtime; typed revise lands in the same context). Wall time
  lost to run 4 because of a new preview-hydration blocker plus an
  unenforced stop rule, not because of the thread shape. Two fixes
  before the big-ticket comparison: the mid-turn evidence gap, and the
  gpl preview env (BETTER_AUTH_URL; investigate hydration through the
  preview proxy).

### Run 6 (Ship playbook, after the run-5 fixes) — 2026-10-10 15:47–16:23 (deployed 44c590a) — WORK DONE, PR declined by design

- Chat `c_h4bPOe_cr5zB_hPhKFcAE`, project gpl, `playbook: ship`, GLM
  flash, fresh sandbox, the same brief as run 5, unchanged. The
  variables under test: PR #69 (live-turn card evidence, per-slice
  persistence), PR #70 (agents QA at localhost), and the gpl setup env
  (auth on localhost; the dev-origin vars).
- **Ask → first PR card: 19m59s** (run 5: 31m22s; run 4: 10m30s to its
  gate). ONE turn, 98 model steps across the whole thread (run 5: 156),
  0 budget continuations, 0 subagent calls.
- **Every run-5 fix held:**
  - Card evidence: "Screenshots: 5" on the first card and 7 on the
    second, all attached in the LIVE turn; the runtime check passed
    (235/235, 7 s).
  - Per-slice persistence: the DB monitor showed every slice as it
    landed. This is the first run observable from sqlite in real time.
  - QA at localhost: every agent-browser call went to
    `http://localhost:3006`; zero to the preview URL. It hydrated and
    auto-logged-in first try. Zero hydration debugging, zero auth
    internals (run 5: 78 agent-browser calls, 20 auth hacks).
- **Revise loop, second time:** the typed revise ("max-w-6xl, 70vh,
  re-shoot") answered the card. The same turn applied both, re-shot,
  amended into one clean commit, and re-carded in **4m07s** (run 5:
  3m41s).
- **Engineering:** the best fix after run 4's. It used `sm:max-w-6xl`
  (the `sm:` variant, so the base `sm:max-w-lg` is overridden; the
  tailwind-merge trap run 4 named), measured 512 → 1152 px in the
  browser, plus a 1024 px responsive shot.
- **Where the remaining ~10 min over run 4 went: seed data, not the
  platform.** The Products tab needed a previewable asset, and the gpl
  seed has none in minio. The thread generated a PDF, uploaded it,
  and ran a TCP proxy so the presigned `localhost:9000` URLs resolved
  inside the sandbox (~20 calls). That is the gpl setup's `seed` not
  covering this page — a setup gap (fix: seed one asset into minio, or
  a `localhost:9000` alias for the minio service), and arguably within
  the stop rule's spirit, since it was making the QA possible, not
  digging into app internals.
- Ending: declined the revised card with a stop note ("trial run, keep
  it local") → a two-line summary. Branch local; every pending input
  resolved.
- **Verdict:** the 0037 shape is now on par with run 4's `flow` on
  quality, with the revise loop `flow` cannot do, and full live
  observability. The remaining gap to run 4 is the seed/minio fixture
  for this page, not the thread shape.

### Run 7 (Ship playbook, services on localhost + asset seed) — 2026-10-10 16:46–17:08 (deployed 2734ad3) — WORK DONE, PR declined by design

- Chat `c_0fwHJVzzBIoS2Pa9u6R_L`, the same brief and model, fresh
  sandbox. The variables under test: PR #72 (services share the
  sandbox's localhost) and the gpl setup `seed` now uploading sample
  files for every asset row.
- **Ask → first PR card: ~10m06s.** Run 4's `flow` took 10m30s to its
  gate. Run 7 matches it on the one-thread shape, with live
  observability and a revise loop that `flow` lacks. ONE turn, **50
  model steps** (run 6: 98, run 5: 156).
- **Zero environment work:** 0 proxy, PDF-generation or auth-hack
  calls; 20 agent-browser calls, all to `localhost:3006`, first try.
  The seeded PDF rendered in the preview dialog.
- **Engineering:** `max-w-[calc(100%-2rem)] sm:max-w-6xl` + 70vh,
  measured 512×510 → 1152×568 in the browser; tests 235/235 via the
  runtime check.
- **One new model slip, caught by the card:** `create_pr` used head
  `feature/wyc-card` (a typo; the work was on `feature/wyc-1589`). The
  card showed "commit summary unavailable", and a typed revise
  re-carded in ~22 s with the right head and its commit. → fix: a head
  that does not exist is a value-shaped error back to the model before
  any card (`no-such-branch`, same PR as this record), so Chad never
  sees a commit-less card.
- Ending: declined the corrected card with a stop note → a two-line
  summary; every pending input resolved.
- **Verdict:** the series is closed for this ticket class. The 0037
  shape matches run 4 on wall time (~10 min) and quality, beats it on
  observability and revise, and the remaining slowness in runs 5–6 was
  environment, now fixed in the platform (services on localhost) and
  in data (seeds). Next: the big-ticket comparison.

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
