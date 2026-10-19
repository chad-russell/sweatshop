# 0053 — PR dashboard: every PR you own, on one page

Status: **draft (for Chad's approval).**

## Why

Chad tracks his open PRs today as a browser bookmark folder ("PRs") of
host URLs — one click per PR, no status, easy to forget one. sweatshop
already talks to both git hosts (0004 GitHost seam, 0052 live PR
state), so it can render the list itself: every PR authored by his
accounts across all project repos — agent-opened AND hand-opened —
with live status and review signals (changes requested, approvals,
comment counts), so "which PR needs me" is one page.

## Scope (agreed with Chad in chat)

- **All PRs by his accounts** across every project repo (deduped by
  URL; author = the credential username — `chad` on Forgejo,
  Chad's GitHub login). Not agent-opened-only.
- **Open first, then recently settled** (merged/closed) dimmed below.
- **A top-level `/prs` page + sidebar nav entry** beside Inbox.

## What changes

### 1. `GitHost.listPRs` (new seam method)

`listPRs(credential, remoteUrl, fetchImpl?)` →
`PRSummary[] | null` (null = could not ask; never throws, matching
`getPRState`).

```ts
interface PRSummary {
  number: number;
  title: string;
  url: string;            // web URL
  state: "open" | "merged" | "closed";
  head: string;           // branch name
  author: string;         // host login
  createdAt: string;      // ISO
  updatedAt: string;      // ISO (any activity: commits, comments, reviews)
  // Review signals, aggregated from reviews (nulls where the host/API
  // can't answer):
  reviewState: "changes-requested" | "approved" | "commented" | null;
  commentCount: number | null;  // issue-style comment threads
  lastReviewAt: string | null;  // newest review timestamp, when any
}
```

- **GitHub:** `GET /repos/{owner}/{repo}/pulls?state=all&per_page=50`
  per repo; for each open PR by the author,
  `GET /repos/{owner}/{repo}/pulls/{n}/reviews` (latest review per
  reviewer wins; CHANGES_REQUESTED > APPROVED > COMMENTED precedence)
  and `GET …/pulls/{n}/comments`? No — comment count comes off the
  list item (`comments` field) — no third call.
- **Forgejo:** `GET /api/v1/repos/{owner}/{repo}/pulls?state=all&limit=50`
  (list rows carry `comments` count; review state derives from the
  list row's `requested_reviewers`? No —) `GET …/pulls/{n}/reviews`
  per open PR by the author for the aggregated verdict.
- Review fetches run only for OPEN PRs by the author (settled PRs
  don't need review state) and are bounded (first 25 open PRs per
  repo — the personal case never hits it).

Author filtering happens client-side of the seam (the caller filters
by credential username) so the seam stays dumb.

### 2. Loader: `lib/prs/dashboard.ts`

Pure-ish assembly over `db()`:

- Every `project_repos` row → resolve credential by host scope →
  `listPRs` → filter `author === credential.username` (case-insensitive).
- Dedupe by canonical URL (same repo can be in two projects).
- Return `{ prs, reposQueried, failedRepos }` — a repo with no
  credential or a host error is reported, never fatal (a red note in
  the UI, the rest of the page still renders).

### 3. Route + page

- `app/prs/page.tsx` — server component, `dynamic = "force-dynamic"`,
  renders `PRDashboard` with the loader's data. Registers
  `PageContextRegistration` (`{ kind: "other" }` — no new viewing
  context kind; `/prs` is not a chat surface).
- No separate API route: the page loads live on navigation (same
  philosophy as 0052 — ask the host on view, store nothing). A manual
  refresh re-asks. If load latency bites later, revisit with a
  client-side refetch endpoint (non-goal now).

### 4. UI: `components/prs/dashboard.tsx`

- Grouped: **Open** (sorted: changes-requested first, then commented,
  then by `updatedAt` desc) → **Settled** (merged, then closed, by
  settled time desc, dimmed, capped at ~10 with the rest behind a
  "show more" toggle).
- Row: status icon + title (link to host) + repo badge + branch chip
  + review badge (`changes requested` warn / `approved` ok /
  `N comments` neutral) + relative time of last activity.
- Empty state: "No PRs by your accounts in project repos."
- No polling: page load is the fetch. (0052's per-PR polling in
  transcripts stays as-is.)

### 5. Sidebar + nav

- `lib/sidebar-nav.ts`: `NavPage` gains `"prs"`, SEGMENT gains
  `prs: "prs"`.
- `components/conversation-sidebar.tsx`: `NavRow href="/prs"
  icon={GitPullRequest} label="PRs"` between Inbox and Projects. No
  badge (a badge needs a background poll — non-goal; the page itself
  is the check).

## Non-goals

- No persistence (no `pull_requests` table), no background polling,
  no webhooks, no agent tool to list PRs (gh/forgejo tools exist).
- No CI/check status (could add later from the same list calls).
- No multi-account-per-host (matches the 0004 credential model).

## Testing

- `git-hosts.test.ts`: `listPRs` per host against a stubbed fetch —
  happy list, author-shape parsing, review aggregation precedence,
  error → null, never-throws.
- `tests/prs-dashboard.test.ts`: loader assembly against a fake seam
  injection (or extracted pure core) — dedupe, author filter,
  ordering (changes-requested first), failed repo isolation.
- `sidebar-nav.test.ts`: `/prs` lights the PRs row.

## Migration

None — no schema change.
