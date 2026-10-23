# 0081 — Structured questions for `ask_owner`

Status: **approved scope (Chad), implementing on `feat/structured-questions`.**

## Why

`ask_owner`'s `kind: "question"` path is one string in, one string back: the
model packs choices into prose ("(a) do X, (b) do Y") and Chad types a
freeform reply that may or may not match what was offered. There is no way
for the model to show WHY it's asking (reasoning lives inside the one-liner,
competing with the actual question), no way to attach evidence (a diff, a
screenshot, a link to a preview) to a specific option, and no fast path for
"just use your judgment" — Chad has to type it out every time.

## Decisions

1. **Four question types, one shared shape.** `single` (radio), `multi`
   (checkbox), `rank` (ordered list), `text` (freeform) — all options at
   once, 1–4 questions per `ask_owner` call, answered together with one
   Submit. `kind: "approval"` is untouched (still approve/deny + comment);
   `questions` is only valid alongside `kind: "question"`.

2. **"Other…" and "You pick" are runtime-supplied, never model-supplied.**
   Every choice-type question (single/multi/rank) always offers both, in
   addition to whatever options the model listed — the model cannot
   suppress "You pick," and `allowOther` (default true) gates only the
   freeform "Other…" alternative (a model asking a yes/no-shaped question
   can turn off freeform while still letting Chad defer to its judgment).
   `text` questions get a plain textarea plus a "You pick" toggle. Dismiss
   (today's `DISMISS_ANSWER` sentinel) stays a separate card-level action,
   answered with the legacy `{answer: string}` shape regardless of whether
   the card is structured — it means "stop waiting entirely," not "answer
   this question with my judgment."

3. **Per-option evidence, resolved at ask time, stored in `card`.** Five
   kinds: `code` ({lang?, text}), `diff` (unified diff text), `markdown`,
   `link` ({url, label?}), `screenshot` (a sandbox PNG path). The model
   supplies a sandbox path for `screenshot`; the tool resolves it through
   the existing `attach_screenshot` core
   (`lib/agent/tools/screenshot.ts`'s `attachScreenshotTool`) BEFORE the
   pending row is written, so what lands in `pending_inputs.card` is an
   attachment id + URL — never bytes in workflow state, and never a
   sandbox path that could go stale. A failed attach (no sandbox, bad
   path, not a PNG) marks that one option's evidence `{type: "screenshot",
   unavailable: true}` — the option still renders, the ask still goes out,
   only that one piece of evidence is missing. Text evidence (code/diff/
   markdown) is capped at 8k chars per option by the tool's own zod schema.

4. **No new column — the spec rides in `pending_inputs.card`.** Same JSON
   column `create_pr`/`update_outline`/`propose_prompt_change` already use
   for runtime-built card payloads (0037). A new discriminated shape,
   `AskOwnerCard` (`lib/question-form.ts`), joins `OutlineCard`/
   `isExecCard`/`isPromptChangeCard` in `db/attention.ts`'s `parseCard` and
   a new `askOwner` field on `PendingRequest`
   (`lib/read-models/attention.ts`). `lib/question-form.ts` is a pure core
   (no db import, same rule as `lib/outline.ts`/`lib/status.ts`) holding
   the types, zod-free validation (`validateStructuredQuestions`), the
   screenshot-resolution function (`resolveStructuredQuestions`, injected
   `attach` callback — testable against a fake), the model-facing result
   formatter (`formatStructuredAnswers`), the composer's typed-text mapper
   (`mapTypedTextToAnswers`), and the server-side answer validator
   (`validateAnswers`) checking a submitted answer set against the stored
   spec (unknown option/question ids rejected, exactly-one-selection for
   `single`, full-permutation for `rank`, no options for `text`).

5. **Hook payload grows an `answers` field, additively.** `chatApprovalHook`
   (`workflows/chat/hooks.ts`) gains
   `answers?: Record<qid, {selected?: string[], other?: string, youPick?:
   boolean}>` beside the existing `answer?: string`. A structured card's
   Submit posts `answers`; Dismiss and the legacy freeform box still post
   `answer`. `POST /api/x/input` validates `answers` against the stored
   `AskOwnerCard` (`validateAnswers`) BEFORE calling `chatApprovalHook.
   resume` — an invalid submission 400s with no resume attempt and no row
   mutation, so a malformed client request can never leave the pending row
   half-answered.

6. **Model-facing result is readable-first, JSON-second.** One line per
   question — `Chad answered — Scope: "Instructions block only"` for a
   single pick, `Chad answered — Scope: you pick — choose your recommended
   option and say which` for You-pick, `1. A 2. B 3. C` ordering for rank,
   a comma list for multi — followed by a compact JSON block
   (`formatStructuredAnswers`) so the model can also parse it exactly. A
   legacy (non-`questions`) ask keeps today's `"${owner} answered:
   ${text}"` verbatim.

7. **Validation is value-shaped, like `create_pr`'s invalid preview.** Bad
   shape (duplicate ids/labels, wrong option count for the type, more than
   one `recommended` on a `single`, options on a `text` question,
   `questions` on an `approval` kind) returns `{ok: false, code: "invalid",
   message}` straight to the model — no pending row, no card, no hook. Old
   calls (`{kind, question}`, no `questions`) are untouched: same schema
   fields, same execution path, same result string.

8. **One shared `QuestionForm` component, no new dependency.** Both the
   transcript's `AskOwnerCard` (`components/chat-cards/approvals.tsx`) and
   the Inbox's `QuestionCard` (`components/inbox/question-card.tsx`) render
   `components/question-form.tsx`'s `QuestionForm` for a structured ask;
   the pre-0081 plain-freeform UI stays for a legacy ask (no `questions`
   array in the tool call's own input — visible before the resolved card
   even loads). The Inbox already has the resolved card inline (`request.
   askOwner`, from `loadPendingRequests`); the transcript card polls `GET
   /api/x/input?toolCallId=` the same way `PendingPRApproval`/
   `AcceptOutlineCard` already do, since the tool CALL's own `input` (what
   streams into the transcript immediately) carries unresolved sandbox
   paths, not the resolved attachment URLs. Rank reordering is up/down
   buttons (`ArrowUp`/`ArrowDown`, the same icons `outline-card.tsx`
   already uses for step reordering) — no drag-and-drop library, per the
   ask-before-adding-a-dependency rule. Keyboard: `1`-`9` selects/toggles
   that option in the focused question, `Enter` submits once every
   question has an answer. Evidence renders expandable per option
   (`code` → the existing `CodeBlockContent` ai-element, `diff` → colored
   +/- lines like `PromptChangeDetails` already renders, `markdown` →
   `MessageResponse`, `link` → a plain anchor, `screenshot` → an `<img>`
   or the "[screenshot unavailable]" line). Semantic tokens only.

9. **Composer typing maps onto the stored spec, not onto the model's raw
   call.** `lib/chat/answer-pending.ts`'s `answerPendingWithText` now reads
   the oldest pending's `card` (`getPendingInputCard`) when its kind is
   `question`; an `AskOwnerCard` with exactly one `single`-type question
   maps typed text to the matching option by 1-based number, letter
   (a/b/c…), or case-insensitive label, maps `"you pick"` to You-pick, and
   anything else to Other on that question. Every other shape (multi,
   rank, text, or more than one question) maps the typed text to Other on
   the FIRST question — documented as the simple case, not a full command
   language. A legacy (non-structured) pending keeps today's exact
   behavior (`{answer: text}` / denial-with-comment for approvals).

10. **Prompt text upgrade follows the guarded path.** `workflows/chat/
    instructions.ts`'s `BASE_INSTRUCTIONS` "Honesty and asking" paragraph
    gains one clause: keep the question short, put reasoning in `context`
    (markdown), use `options` instead of "(a)/(b)" prose. The OLD text
    (byte-for-byte, as it read on `main` before this doc) is frozen as
    `PRE_0081_BASE` in `db/prompt-settings.ts`, and `repairStaleBase` gets
    one more `else if` — a deployed, never-edited `base` row upgrades to
    the new text on next read; a Settings-edited row is never touched
    (same idiom every prior base change has used since 0055).

## Not doing

Drag-and-drop reordering (up/down buttons instead, no new dependency);
per-option evidence for `kind: "approval"` (approvals keep their existing
approve/deny/comment shape — `context` is the only thing approvals gain);
a generic "attach any file type" evidence kind beyond the five listed;
validating evidence URLs are reachable (a `link` is shown as given, same
trust model as any other model-supplied text); multi-select "recommended"
badges beyond what `single` already supports (the cap in decision 7 is
deliberately `single`-only — `multi`/`rank` may mark more than one option
recommended, since "pick several of these" has no single best answer to
flag); server-side rendering of the model's own markdown `context` as
anything other than what `MessageResponse`/`Streamdown` already sanitizes
elsewhere in the transcript.
