# 0078 — Work pill: one PR control, many PRs per thread

Status: **implemented on `feat/work-pill`.** Part of the chat-UI
decluttering pass (sidebar spinner fix, this, chip cleanup). Supersedes
0059's header-variant `DiffBreakdownChip` and 0052's `pr-open` `Phase`
kind.

## Why

A thread's header carried two separate chips once a PR opened: the
phase chip relabeled itself "PR open" (0052), and a diff-breakdown chip
sat beside it (0059). Neither handles a thread that opens more than one
PR (a ticket that ships in several PRs, or a retried `create_pr`) — the
phase chip only ever read the NEWEST call, so earlier PRs vanished from
the header entirely. The per-category diff breakdown is the part worth
keeping; it just needed a home that scales to N PRs.

## Decisions

1. **One pill, not two chips.** `components/work-pill.tsx` replaces the
   PR-open `PhaseChip` + header `DiffBreakdownChip` pairing. `PhaseChip`
   goes back to being outline-only (`lib/thread-phase.ts`'s
   `phaseFromMessages` no longer reads `tool-create_pr` at all — a PR
   is never the phase). 0 PRs renders nothing; the outline chip owns
   the header in that case, same as before a PR existed.
2. **Every create_pr call is tracked, not just the newest.**
   `lib/work-prs.ts`'s `workPRsFromMessages(messages)` walks the whole
   transcript and returns one `WorkPR` per call: `pending` while
   awaiting approval, `open` once it succeeds, dropped entirely once
   denied/sent-back (`ok: false`) or errored. A retried open (same PR,
   a second `create_pr` call) dedupes by URL — newest result wins, kept
   at the first call's position so the list doesn't reorder itself.
3. **The diff breakdown aggregates across PRs, in the same fixed
   categories.** `mergeBreakdowns(list)` sums files/added/deleted and
   each category across every PR that carries one, using
   `DIFF_CATEGORY_ORDER` (exported from `lib/diff-breakdown.ts`, not
   duplicated) so the aggregate table sorts exactly like a single PR's
   always has. A PR without a breakdown (an older result) just
   contributes nothing; if none of them have one, the pill shows no
   diff segment at all — the PR segment still works on its own.
4. **Live state (0052) still applies, per PR.** `applyLiveStates(prs,
   states)` overlays the host's live answer (merged/closed) onto each
   OPEN pr's `displayState`; a pending PR has no live state to ask for
   yet. `components/chat-session.tsx` polls `usePRStates` for every
   open PR's URL (not just one), same 5 s/visible-tab/settle-once rule
   as before.
5. **The pill's shape:** a single split control, same height as the
   other header pills. One PR: a state dot + `#n` + word (`open` /
   `merged` / `closed` / `needs you` for a still-pending call). Several:
   a PR icon + count, the dot coloured by whichever PR needs the most
   attention (pending > open > merged > closed). A divider plus
   `N files +A −D` follows when any PR carries a breakdown, then a
   chevron. One Popover for the whole pill: a row per PR (dot, `repo
   #n` parsed off its URL, title, its own `+A −D`, a View PR link —
   "awaiting approval" instead of a link while pending), then the
   aggregate category table below. Semantic tokens only — `pending` is
   `warning`, `open` is `info`, `merged` is `success`, `closed` is
   `muted-foreground`; below `sm` the words drop ("files", the state
   word) but the dot and numbers stay, tap targets stay ≥ `h-10` on
   coarse pointers.
6. **The transcript's own PR card slims to one line.** `repo #n` is
   read off the PR's URL the same way the pill does —
   `prUrlCoords` moved out of `components/chat-cards/approvals.tsx`
   into `lib/work-prs.ts` so both share it (the tool input's own `repo`
   field is the local work-root directory name, not `owner/repo`, so it
   was never the right thing to show here). The collapsible still holds
   the body, branch chips, and the per-PR breakdown chip; the pending
   approval UI is unchanged.

## Not doing

A PR table, cross-thread PR tracking (that's the `/prs` dashboard,
0053), per-PR dismissal, or changing what `create_pr`'s tool result
carries (`workPRsFromMessages` reads the same shape 0059 already
produced).
