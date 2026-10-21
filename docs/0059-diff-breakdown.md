# 0059 — Diff breakdown chip

Status: **approved in chat (2026-10-21).**

## Why

A PR's raw size ("35 files +504 −105") doesn't say whether that's real
code or a lockfile and a migration snapshot along for the ride. The
create_pr approval card already reads the sandbox's git state for free —
it can sort the diff into categories instead of just clipping a `--stat`
blob, so Chad can tell at a glance where the change actually lives.

## Scope

- The create_pr approval card (inbox + the in-chat pending card).
- The transcript PR card after it opens (the breakdown rides in the
  create_pr tool result, so the card needs no extra fetch).
- Out of scope: the `/prs` dashboard and any host-API file fetching — this
  is sandbox-local, numstat-only.

## Design

### Pure core: `lib/diff-breakdown.ts`

- `parseNumstatZ(output)`: `git diff --numstat -z` rows. `-z` drops the
  normal `<added>\t<deleted>\t<path>` single path field for a rename in
  favor of an empty path field followed by two NUL-terminated paths (old,
  then new) — the new path is kept. A binary row reports `-\t-` for both
  counts; it counts toward `files` but adds no lines.
- `classifyDiff(rows)`: sorts rows into fixed categories, first match
  wins, patterns fixed in code (not configurable):
  - **Generated**: lockfiles (`package-lock.json`, `pnpm-lock.yaml`,
    `yarn.lock`, `*.lock`, `skills-lock.json`), `drizzle/meta/**`,
    `.agents/**`, `*.snap`.
  - **Tests** (mocks and fixtures included, decided): `tests/**`,
    `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `**/fixtures/**`,
    `**/mock*`, `**/*mock*.*`.
  - **Docs**: `docs/**`, `**/*.md`, `**/*.mdx`.
  - **Migrations**: `drizzle/*.sql`.
  - **Config**: `*.config.*`, `package.json`, `tsconfig*.json`,
    `.github/**`, `Containerfile*`.
  - **Code**: everything else (the catch-all).
  Empty categories are left out of the result; a zero-row diff returns no
  categories at all.
- No db import, no git — unit-tested with fixture numstats.

### Gather: `lib/agent/tools/pr-preview.ts`

- `runGitSummary` adds a `git -C <repo> diff --numstat -z <base>...<head>`
  call (same `SAFE_NAME` guard as the existing log/rev-parse calls) and
  classifies its output. The old `git diff --stat | tail -16` call is
  dropped — the category table replaces it in the card text, not just the
  UI.
- `formatPRSummary` renders a compact category table (one line per
  non-empty category plus a Total row) in place of the clipped stat blob,
  so the model and the inbox's text view carry the same breakdown as the
  UI.

### Evidence and UI

- `breakdown?: DiffBreakdown` rides on `ApprovalEvidence`
  (`lib/agent/tools/evidence.ts`), set by `buildChatPRPreview` — both
  approval cards get it through the existing evidence fetch, no new
  round trip.
- `components/diff-breakdown.tsx`: a chip (`FileDiff` icon, file count,
  `+added` in `text-success`, `−deleted` in `text-destructive`) that
  opens the existing shadcn Popover (`components/ui/popover.tsx`) with
  the per-category table and a Total row. Semantic tokens only, no new
  dependency.
- `create_pr`'s tool result carries `breakdown` (merged in alongside the
  host's `{ url, number }` once Chad approves), so `PullRequestToolCard`
  renders the same chip next to the branch chips with no extra fetch.
  Older results without a `breakdown` field render nothing — additive,
  never a migration.
- The thread header shows the same chip (`variant="header"`, matching
  `PhaseChip`'s header pill) beside the phase chip once a PR has opened —
  `lib/diff-breakdown.ts`'s `latestDiffBreakdown(messages)` reads the
  newest successful `tool-create_pr` part out of the transcript, the same
  way `lib/plan.ts`'s `phaseEvents` does.

## Checks

Unit tests on the parser and classifier (fixture numstats, including the
`-z` rename form and binary rows), updated `pr-preview` tests for the
numstat gather and the new summary text, typecheck/lint/test gates before
every commit.
