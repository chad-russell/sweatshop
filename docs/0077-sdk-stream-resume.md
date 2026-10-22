# 0077 — Live turns on the AI SDK's own resume path

Status: **approved in chat (outline v1, 2026-10-22).** Supersedes the
live-turn half of 0076 (PR #19) and its follow-ups #20/#21: the slice
poll, `foreignLive`, `replaceLiveTurn`, `liveTurnChanged`. Keeps 0075's
tail-window hydration and load-earlier paging.

## Why

Before #19, a reload mid-turn mounted `useChat({ resume: true })` and the
stream route replayed the turn's durable journal **from chunk 0**
(`getReadable({ startIndex: 0 })`, hard-coded) — 10–30 s on long turns,
because the local world reads one file per chunk. #19 removed the SDK
live path and replaced it with a homemade 2 s store poll; every bug since
(#20: sending tab saw an empty stream; #21: a growing fold kept its id so
the poll saw "nothing new") lived in that layer, and the thinking/done
indicator stopped tracking the turn.

The slowness was never the SDK's. Both layers already support resuming
mid-stream and nobody used it:

- `world.streams.get(runId, name, startIndex)` (world-local) starts its
  disk walk AT `startIndex` — earlier chunk files are never read.
- `WorkflowChatTransport.reconnectToStream({ startIndex })` /
  `initialStartIndex` send `?startIndex=N` to the reconnect route.
- `useChat`'s resume continues the LAST message in place when the
  stream's message id matches it (`replaceMessage` when ids match).

## Decisions

1. **Stream cursor per persisted slice.** `persistTurn` (non-final)
   records `conversations.active_stream_cursor` = the number of RAW
   journal chunks written so far, read in the step with
   `run.getReadable().getTailIndex() + 1` (world `streams.getInfo`, a
   metadata scan — no payloads). Cleared with `active_run_id`. One
   nullable integer column, one migration.

2. **One index space: raw journal chunks.** The reconnect route reads
   `getReadable({ startIndex })` and pipes `createModelCallToUIChunkTransform()`
   (no `uiStartIndex`). The client never computes UI chunk offsets; it
   passes the server-supplied cursor through `reconnectToStream({ startIndex })`.
   The transport's own mid-stream retry counts UI chunks, so the route
   ALSO accepts the transport's retry: it answers with
   `x-workflow-stream-tail-index` and the client retry path restarts
   from the stored cursor (bounded replay — one slice), never from 0.

3. **Hydrate rows, then resume.** `/c/<id>` and the agent panel hydrate
   the tail window INCLUDING the live turn's persisted slices (as today),
   then the session calls `chat.resumeStream()` with the cursor. The
   resumed stream begins at a slice boundary (`start`/`start-step`),
   so the first assistant chunk carries the in-progress slice only.
   If the SDK renders it as a new assistant message rather than
   continuing the hydrated fold, that is cosmetic and bounded: at turn
   `finish` the session reloads the tail from sqlite (the existing
   settled refetch), which re-folds the turn. Verified empirically in
   implementation; whichever happens is documented here.

4. **Wakes and steers reattach the same way.** A wake turn (started
   server-side) or a send that steered into a live turn: the existing
   settled context fetch (`context=1&tail=1`, which already returns
   `activeRunId`) learns a run is live → merge the newest rows, then
   `resumeStream()` from the cursor. The steered send's empty stream
   stays (it must not replay). The 5 s wake poll stays ONLY to notice
   a server-started turn while idle with background work out; it no
   longer merges live content — it hands off to resume.

5. **Indicator = `useChat` status.** Thinking/Working shows iff
   `status` is `submitted`/`streaming`. Since every tab that sees a live
   run is resumed onto it, every tab gets the same signal, and it goes
   off on `finish`. The Stop button returns for resumed tabs too.

6. **Tool grouping is untouched.** `groupParts` (0056) is a pure
   render-time fold over `message.parts`; it does not care whether parts
   came from hydration or the stream.

7. **Deleted:** the slice poll, `foreignLive`/`liveElsewhere`,
   `replaceLiveTurn`, `liveTurnChanged`, the wake poll's live branch,
   `resumeRunRef` (the transport's default reconnect URL is the run id).

## Not doing

- No change to `persistTurn` row ids, the turn workflow loop, or the
  journal GC.
- No per-chunk cursor or server-side UI-chunk translation.

## Verification

Headless browser against bee after deploy: reload a long chat mid-turn —
first paint < 1 s, text/tool cards keep streaming, indicator on, then off
at finish with the transcript identical to a fresh load. Finished chat
load time recorded. A wake-started turn in an idle tab attaches.
