# 0082 — In-app changelog

Status: **approved scope (Chad), implementing on `feat/changelog`.**

## Why

Chad has no way to see what shipped without reading git log or PR titles —
both engineer-shaped, not a quick "what changed recently" skim. Every other
piece of user-facing state in this app (outline, PRs, inbox) has a page;
"what changed" doesn't.

## Decisions

1. **`CHANGELOG.md` at the repo root is the single source of truth.** Plain
   markdown, human-edited (by whoever lands a PR) and human-readable on
   GitHub even without the app. Format: `## YYYY-MM-DD` date headings,
   newest first; under each date, one bullet per entry, tagged
   `- **Added** …` / `- **Changed** …` / `- **Fixed** …`. A header comment
   at the top of the file explains the format to agents (AGENTS.md also
   states the authoring rule — see below). No database table: unlike
   skills (0054) or prompt sections (0054), there is no runtime-editable
   state here and nothing to seed or version — the file IS the state, and
   git history IS its version history.

2. **Read at request time, not built in.** `lib/changelog.ts` reads
   `CHANGELOG.md` from the repo root with a synchronous `readFileSync`
   (same idiom as `lib/skill-files.ts`'s git-shipped skill reads — no new
   pattern) and parses it into `{date, entries: [{tag, text}]}[]`. Request-time
   reads mean a deploy's new `CHANGELOG.md` shows up the moment the new
   build is live, with no separate seed/migration step.

3. **The parser is tolerant, not strict.** An untagged bullet (no leading
   `**Tag**`) falls back to a generic tag rather than being dropped — the
   format is a convention for humans and agents to follow, not a schema to
   validate against. Lines that are neither a date heading nor a bullet
   (blank lines, the header comment, stray prose) are silently skipped. A
   missing or unreadable `CHANGELOG.md` renders an empty list, not an
   error page.

4. **No new dependency for rendering.** The page reuses
   `MessageResponse`/`Streamdown` (already in the repo, used throughout
   chat) to render each bullet's text, so `**bold**`, `` `code` ``, and
   links in an entry render as intended instead of showing literal
   asterisks/backticks.

5. **Ships with no runtime config change.** The app's production deploy
   (0045) is `next build` + `next start` against the full git checkout —
   not a pruned `.next/standalone` bundle — so a root-level file read via
   `process.cwd()` at request time is already present, the same way
   `skills/*/SKILL.md` already is. No `outputFileTracingIncludes` or
   Containerfile change is needed; `next.config.ts` and
   `Containerfile.dev`/`Containerfile.sandbox` were checked and don't
   prune or `output: standalone` the build.

6. **Sidebar link, not a new top-level flow.** A compact icon-only link
   sits in the sidebar footer next to Settings and the theme toggle —
   consistent with those two being the only "app-level, not
   project-level" controls there (0040).

7. **Going forward, PRs keep the file current.** AGENTS.md gains a rule:
   any PR with a user-visible change adds one short, Chad-facing bullet
   under today's date in the same PR. Purely internal work (refactors,
   tests, chores, docs-only) doesn't need one — the bar is "would Chad
   care," not "did code change."

## Not doing

- **No unread dot/badge.** The sidebar signal system (0008) is built for
  pending-input/unseen-message tracking with a 5 s poll
  (`lib/use-attention-sync.ts`); wiring the changelog into that is more
  machinery than a changelog warrants. The page itself is the check, same
  reasoning as the PR dashboard (0053).
- **No backfill.** History before this doc doesn't get reconstructed from
  git log — `CHANGELOG.md` starts with exactly one entry, today's. Digging
  up what shipped before this point is still a git-log job.
- **No CI check.** Nothing enforces that a PR actually added an entry when
  it should have; it's a convention stated in AGENTS.md, not a gate in
  `.github/workflows/ci.yml`. A missed entry is a minor miss, not a build
  failure.
