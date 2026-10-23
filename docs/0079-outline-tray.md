# 0079 — Outline tray: an always-visible outline, docked to the composer

Status: **implemented on `feat/outline-tray`.** Part of the chat-UI
decluttering pass (sidebar spinner fix, 0078's work pill, this, chip
cleanup). Supersedes the header's outline chip (0064's "the header
chip" UI decision) and narrows `components/outline-card.tsx`'s
transcript card to match.

## Why

The outline (0064) is the one plan/progress mechanism, but the only
places to see it were the header's one-line chip (`<active step> ·
d/n`) and wherever the last `update_outline` tool card happened to sit
in the transcript — which, in a long thread, can be scrolled far out of
view. Chad's ask: see progress and current status at any point in the
chat, not only by scrolling to find the card. The per-category diff
breakdown precedent (0059, carried into 0078's work pill) was the same
shape of problem — pull the thing people actually want to glance at out
of the scrolling transcript and into a fixed, always-reachable spot.

## Decisions

1. **One always-visible tray, docked to the composer, not floating.**
   `components/outline-tray.tsx` renders directly above `PromptInput`
   in `components/chat-session.tsx`'s composer wrapper, sharing its
   width and rounded-top corners so it reads as part of the composer
   rather than a separate card. It renders nothing before the thread's
   first `update_outline` call — same as the old chip's absence.
2. **Collapsed by default, one line, expands UPWARD.** The collapsed
   bar is a button: a segmented progress strip (one segment per
   top-level step, coloured by state — done=success, active=info
   pulsing only while the chat is busy, blocked=warning,
   pending/skipped=muted) + `d/n` + the active/blocked step's label
   (`lib/outline.ts`'s `outlineTraySummary` — the same precedence as
   `outlineChipLabel`, factored through a shared `fallbackNamedStep`,
   but the label alone since the tray shows the count and any "needs
   you" badge as their own elements) + a chevron. Expanding grows the
   composer area upward (the checklist appears above the bar, which
   stays anchored directly against the composer) into the full
   `OutlineDocument` tree, capped at `max-h-[min(50dvh,28rem)]
   overflow-y-auto` — the same region serves as the "sheet" on mobile,
   no new dependency. Never auto-expands, including when a review opens
   — the collapsed bar's `needs you` indicator (warning-coloured,
   shown when a step is blocked or a review is open) is enough; Escape
   collapses it when focus is inside and returns focus to the toggle.
3. **Fed from the whole transcript, like `phase` and `prs` already
   are.** A tail window (0075) might not contain the outline's last
   rewrite. `ChatContextBlock` (`lib/chat-ui.ts`) gained `outline:
   OutlineTrayContext | null` — `lib/outline.ts`'s
   `deriveOutlineTrayContext` reuses `outlineHistory` (the transcript
   card's own source) and `deriveOutline`'s stale bit rather than
   re-deriving either, carrying the current outline, its previous
   snapshot (for "changes since"), the open review's row id (what
   Approve needs), and `approved`. `components/chat-session.tsx`
   prefers `serverContext?.outline` over the visible window's own
   derivation, same pattern as `phase`/`prs`.
4. **The review/edit/approve flow is ONE implementation, not two.**
   `OutlineBody` (`components/outline-card.tsx`) is the document + edit
   button + `OutlineEditor` + saved note + `OutlineApprove` extracted
   out of the transcript card — fully controlled (the caller owns which
   outline/version/reviewId is current, including after a save via
   `onSaved`) so both the card's header and the tray's collapsed bar
   stay in sync with an edit instantly, exactly as the card always has.
   The tray passes `conversationId`/`projectId`/`quote` as plain props
   (`OutlineBodyView`) instead of through `OutlineViewProvider` — the
   tray sits outside that provider's subtree (the composer, not the
   transcript), and three props isn't worth hoisting the provider for.
5. **The transcript card shrinks to match.** Since the tray is now the
   one place status is always visible, a card doesn't need to argue for
   attention: only the latest card defaults open, and only while it's
   an open review (so Approve stays obvious inline too); every other
   card — including a settled latest one — defaults closed to one slim
   line (`Outline vN` + goal, plus a cheap one-line change summary,
   `lib/outline.ts`'s `outlineChangeSummary`, when every change since
   the previous snapshot was a step finishing — anything more mixed is
   omitted rather than summarized badly). The `recorded`/`approved`/
   `superseded` pill text is gone too — a pill now only appears for
   `needs you` (open review) or `failed`; `Card`'s `pill` prop became
   optional to support that. A step's runner badge only shows when the
   runner is actually pinned (not the default `auto`) — noise either
   way, but more visible now that cards sit closed by default.
6. **The header's outline chip is just gone.** `components/status-chip.tsx`'s
   `PhaseChip` lost its `header` variant (now only the agent panel's
   compact chip uses it) and `components/chat.tsx`'s header is crumbs ·
   the work pill (0078) · the preview pill. `phaseFromMessages` is
   unchanged (outline-only since 0078) — it still backs the agent
   panel's compact chip, which this doc doesn't touch.

## Not doing

A notification/badge system beyond the tray's own `needs you`/`stale`
indicators, auto-expanding on review or on blocked, a separate mobile
sheet component (the same max-height scroll region serves both), or
touching the work pill / sidebar (0078 and the sidebar PR own those).
