# 0032 — Eve remnants retirement

Status: **draft — awaiting Chad's approval.** Scope expanded 2026-10-07
per Chad: "anything that is purely historical data can be deleted; this
is only a prototype so far and we don't need any backward
compatibility." This supersedes 0010 Phase 6's "db/mirror.ts stays as
the ingest utility" decision.

## Why

0010 removed the eve runtime on 2026-10-01; Phase 6 retired the
`conversation_events` mirror (nothing writes it) and imported
transcripts into `messages`. What remains is pure residue:

- `db/attention.ts` still derives "eve-runtime" pending requests by
  folding the dead table's `input.*` / terminal events
  (`pendingFromEvents` + its query), and `PendingRequest.runtime`
  routes each card.
- `components/inbox/use-respond.ts` posts eve-runtime answers to
  `/eve/v1/session/<id>` — **an endpoint that does not exist in this
  app** (it lived in the prototype). A card raised by the fold would
  answer into a 404.
- The `conversation_events` table, `db/mirror.ts`, and two one-time
  scripts (`scripts/backfill-messages.mjs`, `scripts/import-eve-conversations.mjs`)
  exist only to serve a runtime that is gone. Live-DB evidence
  (2026-10-07): **0 `input.*` events ever**; the eve importer has
  already run and is idempotent against nothing left to import.

Principle (0031's, plus today's ruling): delete code and data that
answer a question no live runtime can ask. Pending requests collapse
to one *stored* source (`pending_inputs` rows).

## The cut

One PR, sequenced commits. One migration (`DROP TABLE`). No dependency
change.

### 1. `db/attention.ts` — the fold

- Delete `EventRow`, `asRequest`, `pendingFromEvents`,
  `INPUT_EVENT_TYPES`, and the `conversationEvents` query inside
  `loadPendingRequests`. The `conversationEvents` import goes.
- `loadPendingRequests(db, onlyIds?)` keeps its name and signature but
  becomes a direct `pending_inputs` read (today's `mergePendingInputs`
  body, honoring `onlyIds` in the query). Call sites in
  `loadAttention`/`loadInbox` are unchanged.
- `PendingRequest.runtime` is deleted; the module header's
  derived-from-mirror paragraph is rewritten (needs-you =
  unresolved `pending_inputs` rows plus machine gates).

### 2. `components/inbox/*` — the dead endpoint

- `use-respond.ts`: the `runtime` parameter, the `/eve/v1/session`
  branch, and the `sessionId` parameter (it existed only for that URL)
  are deleted. The hook always posts to `/api/x/input`.
  `approval-card.tsx` / `question-card.tsx` call sites drop the
  arguments.
- `inbox-view.tsx`: the fixed 800 ms delayed refresh after answering
  (sized for the eve mirror's async write latency) becomes an immediate
  refresh — a chat-runtime answer resolves the row before responding.

### 3. `conversation_events` — table and data

- Migration `drizzle/0035_drop_conversation_events.sql`:
  ``DROP TABLE `conversation_events`;`` (with its drizzle snapshot).
  Historical rows go with it — sanctioned above; nightly restic and
  pre-deploy snapshots retain a copy regardless.
- `db/schema.ts`: the table definition, its two indexes, the
  `ConversationEvent`/`NewConversationEvent` types, and the header
  comment describing the mirror go.
- `db/organize.ts`: the cascade delete of a purged conversation's
  event rows (and its `conversationEvents` import) goes.

### 4. `db/mirror.ts` — deleted

- `db/mirror.ts` (147 lines) is deleted outright, with
  `tests/mirror.test.ts` and `tests/mirror-failsafe.test.ts`.
- **Fixture rewrite**: `tests/{search,attention,organize,runs-as-conversations}.test.ts`
  seed eve-style conversations via `mirrorStreamEvent` (which extracts
  text into `messages` rows as a side effect). Rewrite them to insert
  `conversations` + `messages` rows directly — the tables that are the
  actual source of truth — keeping each test's scenario and assertions.
  `attention.test.ts`'s eve-pending block dies with the fold (the
  table-drop makes the old "guard" test structural: typecheck enforces
  that no reader exists).

### 5. One-time scripts — deleted

- `scripts/import-eve-conversations.mjs` + the `chat:import` npm
  script: the importer has run; it is idempotent against nothing.
- `scripts/backfill-messages.mjs`: the 0003 backfill extracted
  `messages` from mirrored events; both ends of that pipe are gone.

### 6. Docs

- `AGENTS.md`: the inbox paragraph's eve-era sentence goes; the store
  paragraph's "db/mirror.ts stays as the ingest utility … Eve-era
  transcripts were imported (`npm run chat:import`)" sentences are
  replaced with a one-line historical note pointing at docs/0010 and
  this doc.
- docs/0002's dual-write invariants are already marked historical; no
  change.

## Stays (do not over-delete)

- **Eve-era `conversations` + `messages` rows** — the imported
  transcripts are live, browsable history (what "purely historical"
  does not mean). No conversation content is touched.
- **`pending_inputs` mechanics** (`ask_chad` → `pendingStep` →
  `/api/x/input`) and **machine gates** — untouched.
- **0008's polling attention model** — no SSE, no push.
- **`archive/prototype` branch + `v0.*` tags** — version-control
  history governed by the old-repo policy, not db residue.
- 0031's keep-list, unchanged.

## Signature note

`loadAttention`'s signature loses the eve request-id contributors;
every client sees exactly one signature change at deploy → one
refresh. The signature is a diff value, never stored; not a contract.

## Adjacent, NOT in this cut

`NeedsYouThread` doesn't carry `kind`, and approval/question cards
hardcode `/c/${thread.id}` — a pending request on a run conversation
mis-links. The fix (store adds `kind`; cards use `conversationHref`)
touches the same two cards but is additive; it ships separately
whenever convenient.

## Estimate

~−650 lines net (attention ~140, mirror 147 + its ~300-line tests,
scripts ~250, use-respond/cards, fixture rewrites add a little back),
one table, one migration, two npm-script deletions. The system loses a
whole conceptual axis: "which runtime raised this request" and "the
mirror" both leave entirely.
