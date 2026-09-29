# 0003 — Conversation search (FTS5)

Status: **shipped** (2026-09-29).

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

## Verification (2026-09-29)

- `/api/search?q=` returns bm25-ranked conversation hits with marked
  snippets; a brand-new session became searchable live (no backfill), and
  crafted input (`"NEAR" OR * && x`) returns empty — no 500, no injection.
- Backfill extracted from existing mirrored events; re-running inserts
  nothing (idempotent, ULID-keyed).
- 16 tests green (7 new: extraction roles, replay idempotency, match +
  grouping + snippet, empty/unmatched, phrase-quoting, crafted input).
- **Found and fixed during verification:** `snippet()` is an FTS5
  auxiliary function and cannot be used in a GROUP BY query ("unable to
  use function snippet in the requested context") — the SQL is now flat
  per-row matches and grouping happens in TypeScript.
- **Operational gotcha recorded:** eve's dev watcher rebuilds authored
  artifacts on `agent/`-tree changes, but the mirror hook imports
  `db/mirror.ts` outside that tree — editing it does NOT trigger a
  recompile, and the running runtime keeps stale code. Symptom: events
  mirrored but no message rows. Fix: restart `./dev` (fresh compile) and
  run `npm run db:backfill` to heal the gap. Noted in AGENTS.md.
