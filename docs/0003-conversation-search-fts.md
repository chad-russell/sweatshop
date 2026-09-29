# 0003 — Conversation search (FTS5)

Status: **approved by direction** (2026-09-29) — Chad: "add the FTS next,
should be easy and not require much design." Sized light accordingly; this
doc records the decisions, it does not gate them.

## Goal

Full-text search across all conversation messages, surfaced as a search
box in the sidebar. The payoff the 0002 event mirror was built for.

## Decisions

| Decision      | Choice                                                              | Why                                                       |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------------- |
| Engine        | SQLite FTS5 (bundled with better-sqlite3's SQLite — verified)       | Zero new dependencies; the north star is sqlite-only       |
| Indexed unit  | Extracted **message text**, not raw event JSON                       | Raw JSON would match keys/punctuation, not conversation    |
| Source table  | `messages` (id = event ULID, conversation_id, role, text, at)        | Idempotent by construction (same ULID key as events)       |
| FTS structure | External-content virtual table `messages_fts` over `messages` rowid, | Triggers keep index in sync regardless of writer (mirror, |
|               | porter + unicode61 tokenizer, insert/update/delete triggers          | backfill); reindex is derivable from `messages`            |
| Writers       | The mirror extracts text rows on `message.received` (user) and       | Single code path; only on genuinely-new events             |
|               | `message.completed` (assistant); background-task input is skipped    |                                                           |
| Ranking       | bm25, grouped by conversation with `snippet()`                       | Best-default relevance; one hit row per conversation       |
| Query safety  | User input phrase-quoted (doubled inner quotes)                      | FTS5 query syntax cannot be injected                       |
| Surface       | `GET /api/search?q=` (route handler reads sqlite) + debounced search | No new pages; search lives where the list lives            |
|               | box in the sidebar; results replace the recents list while typing    |                                                           |
| Backfill      | `scripts/backfill-messages.mjs` — idempotent extraction from already-| Existing mirrored conversations become searchable now      |
|               | mirrored `conversation_events`                                       |                                                           |

## Non-goals

Role/date filters, pagination, in-transcript highlighting, search over
reasoning text, titles-only matching tweaks.

## Verification

- Mirror writes `messages` rows for user + assistant text; duplicates
  insert nothing.
- Backfill populates from existing events; re-running changes nothing.
- `/api/search?q=` returns bm25-ranked conversation hits with snippets;
  crafted input (quotes, `NEAR`, `*`) cannot break the query.
- Sidebar search shows results live; clearing restores the recents list.
- typecheck + lint + tests green (new tests: extraction, idempotency,
  search match/sanitize).
