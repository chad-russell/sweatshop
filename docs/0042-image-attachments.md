# 0042 — Image attachments in the composer

Status: **proposed — awaiting Chad's approval before any code.** The UI half
of the original request (up-arrow send, model and sandbox pickers inside the
input) is separate and already in PR #103; this doc is the image half.

## Why

The composer takes text only. Chad wants to paste a screenshot, drop a file
or pick a photo (phone included) the way ChatGPT's composer allows: a `+`
button, paste, thumbnails in the input, and a hover `×` to remove one. The
model should then see the image, and the transcript should show it after a
reload.

Most of the client half already exists. The vendored AI Elements
`prompt-input.tsx` carries attachment state, paste handling, drop handling,
the hidden file input, Backspace-removes-last, and `accept` / `maxFiles` /
`maxFileSize` validation. `chat-session.tsx` simply renders none of it, and
`handleSubmit` drops `message.files`. The work is on the server: today a
user message is a plain string end to end.

## Decisions (Chad, 2026-10-15)

- **Files on disk, resolved at call time.** An image is stored under
  `data/attachments` (the 0035 root, served by `/api/attachments/<id>`). The
  message row stores a reference, never the bytes. The bytes are read when the
  model is called. No base64 in sqlite and none in the workflow's recorded
  state.
- **A model without vision blocks the send.** The composer shows an inline
  notice and send stays disabled until the image is removed or the model is
  switched. The catalog already has `ModelInfo.vision` (static for GLM/Gloo,
  from `architecture.input_modalities` for OpenRouter).
- **Delivered after PR #103** as its own PR.

## What changes

### 1. Storage and upload

`POST /api/x/attachments` takes one image as multipart form data and returns
`{ id, url, mediaType, bytes }`.

- Types: PNG, JPEG, WebP, GIF, **checked by magic bytes** (never the client's
  MIME or filename). Cap 10 MiB per image (0035's cap), at most 4 per message.
- The file lands at `data/attachments/att_<hex>.<ext>`. Ids stay
  `att_<hex>`, so the 0035 screenshot files keep working unchanged;
  `/api/attachments/[id]` learns to try the four extensions and serves the
  right `content-type` (immutable cache, as now).
- New table `attachments(id, media_type, bytes, conversation_id NULL,
  created_at)`. An upload is **unattached** until a send claims it
  (`conversation_id` set). Unattached rows older than 24 h are deleted with
  their file by the existing reaper tick. The 0035 screenshots are not in the
  table and are never swept.
- Deleting a conversation forever (`deleteConversationForever`, the trash
  purge, project delete) removes its attachment rows and files.

### 2. Send path

The browser uploads each file, then sends a normal chat message whose parts
are the text plus one `file` part per image, with
`url: "/api/attachments/att_…"`. No bytes ride in the send.

- `app/api/x/chat/route.ts` reads the ids from the last user message's file
  parts (it already reads its text parts). It requires **text or at least one
  image** (today: text only), rejects unknown ids, ids already claimed by
  another conversation, and more than 4.
- Vision is validated on the server too: when the send carries images, the
  turn's **resolved** route (picked > conversation > project > global, as
  `resolveRoute` does) must have `vision`. Otherwise a value-shaped 400 and
  nothing is created. The client check is a convenience; this is the rule.
- `startChatTurn` and `ChatTurnInput` gain `attachments?: string[]`.
  `recordUserMessage` claims them and stores the user row's `modelMessage`
  as parts: `[{ type: "text", text }, { type: "file", data:
  "attachment:att_…", mediaType: "image/png" }, …]` (a `file` part with an
  explicit `mediaType`, see section 3 for why). `messages.text` keeps the
  text, so search and titles are unaffected.
- **Steers are text only in v1.** `steer_queue` has a `text` column and
  `answerPendingWithText` takes text. While a turn is running the `+` is
  disabled and pasted or dropped images show "wait for the turn to finish".
  Widening the queue is a follow-up if it earns it.

### 3. Resolving the bytes: the model wrapper

This is the one place with design risk. The workflow's `messages` array is
recorded in the run's state, so it must carry only `attachment:` references.
`SerializableChatModel.doStream` (0010) already runs inside a step, in Node,
right before the provider call. It is the seam: before delegating to the inner
model it rewrites each `attachment:att_…` file part in the prompt into
`{ type: "file", data: <bytes>, mediaType }` read from disk.

- The AI SDK downloads URL-typed parts the model does not claim to support
  before `doStream` runs. Read in `ai` 7.0.130 (`downloadAssets`): a part is
  planned for download only when its data parses as a URL, and it is skipped
  when `supportedUrls` matches its `mediaType` and URL. The wrapper therefore
  reports `supportedUrls: { "image/*": [/^attachment:/] }`, and the stored
  part always carries a `mediaType` (a part without one is never "supported"
  and would be fetched). `attachment:att_…` is a valid URL scheme, so it
  reaches `doStream` untouched. **First task of the implementation is a spike
  that proves this end to end** (a mock model asserting it receives the `attachment:` part,
  then bytes inside the step). If the SDK version in the repo does not honor
  it, the fallback is resolving in a dedicated step before `agent.stream`,
  which puts bytes into recorded state: acceptable for one turn, but then the
  doc is amended before shipping, not after.
- **History never breaks.** The recipe in `ChatModelData` gains `vision:
  boolean` (known where the route is resolved, `resolveTurnRouteStep`). When
  false, the wrapper replaces every image part, in this turn and in history,
  with a text part `[image omitted: this model cannot read images]`. So
  switching mid-conversation from a vision model to GLM Flash keeps working;
  the model just does not see old images. A missing file (deleted, restored
  database) degrades the same way with `[image unavailable]`.
- Harness tools (pi, claude, cursor) are unaffected: they get text prompts
  from the agent as before. Giving a harness the image is out of scope.

### 4. The composer

All in `chat-session.tsx` (both frames, page and agent panel, share it), using
the existing AI Elements parts:

- **`+` button** at the left of the footer: `PromptInputActionMenu` with
  "Add photos" (`openFileDialog`). The input uses `accept="image/*"`, so on a
  phone the OS offers camera and library.
- **Paste and drop** already work in the textarea and on the form once files
  are surfaced; set `multiple`, `maxFiles={4}`, `maxFileSize`, `accept` and an
  `onError` that shows a one-line notice above the input.
- **Thumbnails** in a `PromptInputHeader` row: 64 px rounded squares
  (`object-cover`) with a round `×` at the top-right corner. On a mouse the
  `×` fades in on hover and on keyboard focus. **On touch it is always
  visible**, because hover does not exist there and the control would
  otherwise be unreachable (`pointer-coarse:` variant, 44 px hit area to match
  the existing coarse-pointer sizing). Backspace on an empty textarea removes
  the last one (already built in).
- **Send** is enabled with text or images. On submit the files upload first
  (spinner on the send button, thumbnails dimmed); a failed upload keeps the
  composer intact with an error and does not send.
- **Vision gate:** the resolved model is the picked route, else the project
  default, else the chat default (the `ModelsView` the page already fetches).
  Images attached and that model lacking `vision` shows "<model> can't read
  images. Remove them or pick another model." and disables send. The same
  check re-runs when the model picker changes.
- **Drafts:** images live in memory (blob URLs). A reload loses them; the text
  draft persists as today.

### 5. Transcript

`rowsToUIMessages` maps a user row's `image` parts to UI `file` parts with
`url: /api/attachments/<id>`. `ChatMessageView` renders them above the text:
rounded thumbnails, up to 2 columns on a phone, click opens full size (the
`ScreenshotCard` lightbox is reused rather than writing another). The
optimistic user message (before the server round trip) renders the same parts,
so a sent image does not pop in after the fact.

## Non-goals

- PDFs and other documents, audio, video. Images only, so the vision flag is
  the whole capability story.
- Images on steers, on wake messages, or from the agent's own tools (0035's
  `attach_screenshot` stays as it is).
- Client-side downscaling or HEIC conversion. Safari converts HEIC to JPEG on
  pick; a phone photo over 10 MiB is rejected with a clear message. If that
  turns out to bite, downscaling to a 2048 px long edge in a canvas is a small
  follow-up (it would also cut provider token cost).
- Showing the image to a pi/claude/cursor harness.
- Retention policy beyond "lives with its conversation".

## Implementation sketch

One PR, in this order so each step is testable alone:

1. **Spike:** `supportedUrls` pass-through plus in-step byte resolution, with
   the mock model (this decides section 3; see its fallback).
2. Store + upload route + serving route + `attachments` migration + reaper
   sweep and purge hooks.
3. Chat route (parts parsing, validation incl. vision) → `startChatTurn` →
   `recordUserMessage` → wrapper rewrite and non-vision placeholder.
4. `rowsToUIMessages` + transcript rendering.
5. Composer: `+`, thumbnails and `×`, upload-on-send, vision gate, notices.
6. Docs: update AGENTS.md (the Architecture line on attachments) and note the
   attachment contract here.

Tests: upload (magic bytes beat a lying MIME, size cap, 4-image cap, unknown
and already-claimed ids), the chat route (text-or-image, vision rejection with
nothing created), the wrapper (reference to bytes in the step; non-vision and
missing-file placeholders; history with an old image on a non-vision model),
`rowsToUIMessages`, the reaper sweep, and delete-forever removing files. All
against the mock model; nothing waits on a real provider. A live check
(`IMAGE_SPIKE=1`, opt-in like the other spikes) sends one image to a real
vision route.

## Open questions

1. **Swept at 24 h** is a guess for unattached uploads. Is that right, or
   should abandoned uploads go sooner (they are only created by a send that
   then failed or was cancelled)?
2. **Image-only sends.** The model gets just the image with no text part. A
   few providers reject that; if the live check finds one, the route can add
   an empty-prompt note for them. Fine to find out empirically?
