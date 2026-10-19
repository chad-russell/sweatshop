# 0052 — PR lifecycle: the phase chip tells the truth

Status: **approved (in chat, 2026-10-19); implemented on
`feat/0052-pr-lifecycle`.** Implementation notes at the end.

## Why

The thread header's phase chip (0041) says `PR open` the moment a
`create_pr` call returns a URL — and it says it forever. Merges and
closes happen on the host (Chad merges in the Forgejo/GitHub UI); no
event reaches sweatshop, so the chip, the PR card's "opened" pill, and
the transcript all keep claiming a PR is open after it has merged. The
app already holds host credentials (0004 GitHost seam) — it can simply
ask.

## What changes

### `GitHost.prState` (new seam method)

`getPRState(credential, remoteUrl, number, fetchImpl?)` →
`{ state: "open" | "merged" | "closed"; mergedAt?: string } | null`
(null = not found; callers fall back to the derived label). GitHub:
`GET /repos/{owner}/{repo}/pulls/{number}` — `merged: true` → merged,
else `state`. Forgejo: `GET /api/v1/repos/{owner}/{repo}/pulls/{number}`
— `merged` timestamp set → merged, else `state`. Errors return null
(unknown), never throw to the UI.

### One route, batched: `GET /api/x/prs` (new)

Query `?url=<PR web url>` (repeatable). Resolves owner/repo/number from
each URL, resolves the host credential by host scope (the 0004 rule),
calls `getPRState`, returns
`{ [prUrl]: { state, mergedAt? } | null }`. Unresolvable URLs (no
credential, host down, not found) map to null. Never 500s on a bad URL.
Cap ~10 URLs per request.

### Client polling hook: `usePRStates` (new, `lib/use-pr-states.ts`)

Like `useChildStatus` (0040): fetch once on mount, then poll every 5 s
**only while some PR is open and the tab is visible**; stop polling once
every tracked PR is settled (merged/closed) — a settled PR never gets
fetched again on that view.

### Phase chip (`lib/plan.ts` + `components/plan-card.tsx`)

`derivePhase` is untouched — pure, derived from the transcript (0041's
rule holds; the snapshot of a merged PR in an old transcript is
intentional). The label only shows `PR open` while the host still says
open; once merged it reads `PR merged`, closed reads `PR closed`.
Concretely `chat-session.tsx` passes the live state to the chip: when
the derived phase is `pr-open` with a URL, the hook's answer overrides
the label/tone (`merged` → tone ok "PR merged"; `closed` → warn
"PR closed"); `null`/unknown keeps the derived label. The PR URL stays
the link.

### PR card (`components/chat-cards/approvals.tsx`)

`PullRequestToolCard`'s pill shows the same truth: `opened` only while
the host says open; `merged` (success tone) / `closed` (warn tone) once
settled. The "opened" in the tool result stays as-is — it was true when
the call ran.

### `create_pr` tool result (small, non-breaking)

`createPrStep`'s success payload gains `state: "open"` — what the host
reported at creation. No behavior change to the tool; the model's
transcript copy gets one more true field. **Deferred:** a
`pr_state`-refresh tool for the agent — gh/forgejo tools already cover
asking by hand; revisit if a skill needs it.

## Non-goals

- No PR table, no persistence of PR state, no webhook receiver, no
  background polling. State is read live on view, cached in browser
  memory only. (A settled PR's live state is computed at most once per
  view mount; the poll stops.)
- No change to `derivePhase`'s purity or the phase-events model.
- No new dependency.

## Testing

- `getPRState` per host against a stubbed fetch (mirror the createPR
  tests' style): url/auth mapping, merged-vs-closed mapping, not-found →
  null, error → null.
- The `/api/x/prs` route: batch mapping, unknown URL → null, no
  credential → null, cap enforcement.
- `lib/plan.ts`-adjacent: the label-override mapping (merged/closed/
  unknown) as a pure function.
- Polling hook: logic lives behind a small pure `nextPollMs`/should-stop
  rule so tests cover the stop condition without a browser.
