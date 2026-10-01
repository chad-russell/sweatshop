# 0007 — Conversation organization (folders, inbox, archive, titles, search)

Status: **shipped (2026-10-08).** Verified live on the real store (28 conversations migrated, backup taken first), plus a headless-browser drag-and-drop pass.

## Goal

The sidebar is a flat list labelled by each conversation's first user
message, which makes near-identical rows ("Reply with exactly: ok" ×5)
indistinguishable and leaves no way to file, hide, or clean up. Make
conversations findable (better labels, better search) and manageable
(folders, archive, trash).

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Folder scope | Folders live **inside a group** — a project, or "Chats" (no project). `folders.project_id` null = Chats. | A conversation's project binding is immutable (0004); folders organize *within* it. Cross-group moves are rejected. |
| Folder shape | Free-form tree, any depth. `folders(id, project_id, parent_id, name, created_at)`. Sibling names unique (case-insensitive), enforced in code. | Matches "nest to sub-sub-folders". No position column: folders sort by last activity (newest descendant conversation; `created_at` when empty). |
| Filing | A conversation lives in **at most one** folder (`conversations.folder_id`, null = unfiled). Moving is a move, never a copy. | Copies make archive/trash ambiguous and put one conversation in several places. Multi-topic filing is a tags feature, deferred. |
| Inbox | Unfiled conversations appear in a literal **Inbox** section per group, with Today / Yesterday / This week / Older separators inside it. Time buckets exist *only* in the Inbox. | An empty "Today" because you already sorted it would be misleading; "Inbox" says what the section is. Filing a conversation empties it out of the inbox — the inbox shows what has not been dealt with. |
| Time buckets | Deterministic, derived (`lib/age-buckets.ts`), local calendar days, not droppable. | Not places, just a grouping of the Inbox. |
| Deleting a folder | Children (subfolders and conversations) move up one level; nothing is deleted. | Destructive folder delete is a trap. |
| Archive | `archived_at`. Hidden from folders and the inbox; listed under an Archive view; **still searchable**. Keeps `folder_id`, so restore returns it to its folder. | Reversible clutter control. |
| Trash | `trashed_at`. Hidden everywhere except a Trash view; **excluded from search**. Restore clears it; "Delete forever" and a lazy 30-day purge remove the rows (conversation, mirrored events, extracted messages, harness rows). | Matches the "archive/trash from 2" request. Purge only touches the sweatshop mirror — eve's own stream is authoritative and untouched. |
| Generated titles | After the first assistant reply, one GLM Flash call writes a 4–6 word title + one-line summary (`title`, `summary`); regenerated once when the conversation reaches 8 user messages. A manual rename (`title_source = 'manual'`) is never overwritten. | The first-message label is the weakest identifier. Two calls max per conversation keeps cost negligible. |
| Title trigger | `agent/hooks/mirror.ts` calls `lib/titles.ts` fire-and-forget after `message.completed`; failsafe like the mirror (log with `[titles]`, never throw into the stream). | Mirror stays synchronous and model-free (0002 rules). |
| Search | Adds a `conversations_fts` index over title + summary. Title/summary matches rank above body matches. Results carry project, folder path (breadcrumb), archived flag, and highlighted snippet. Filters: `project`, `folder`, `archived`. A ⌘K palette searches from anywhere. | Search was the only retrieval path; it now finds conversations by what they *are about*, not only by words typed. |
| Drag and drop | Native HTML5 drag and drop — **no new dependency** — plus a "Move to…" menu per row as the keyboard/touch path. Server enforces all invariants; the client only mirrors them to disable invalid drop targets. | AGENTS.md: ask before adding a dependency (dnd-kit deferred). |

## Invariants (store layer, `db/organize.ts`)

- A conversation's folder must belong to the conversation's project
  (null ↔ null for Chats).
- A folder cannot be moved into itself or a descendant, and a move cannot
  change its project (it can only re-parent within its group).
- A folder's parent must be in the same group.
- Sibling folder names are unique per (project, parent), case-insensitive.

## Non-goals

Tags/labels, copies in multiple folders, pinning, semantic/embedding
search, folder-level sharing, UI for the search filters beyond a group
chip row and the archived toggle, reordering folders by hand.

## Notes

- Existing conversations backfill as `title_source = 'auto'`, so they are
  retitled the next time they receive an assistant reply.
- Editing `lib/titles.ts` or `db/organize.ts` follows the 0003 gotcha:
  code the eve runtime imports from outside `agent/` needs a `./dev`
  restart.

## Verification (2026-10-08)

- Migration 0008 rehearsed on a copy of the live db, then applied (a
  `VACUUM INTO` backup, `data/sweatshop.pre-0007.db`, is git-ignored).
  `conversations_fts` backfilled all 28 rows; no FK violations.
- Live routes: filing, cross-group (409), folder cycle (409), archive,
  trash (excluded from search), restore, delete-folder promotion.
- Headless Chromium over CDP: Inbox age separators render after
  hydration; a dragged conversation is accepted by a same-group folder,
  refused by another group's header, and the drop files it.
- Not yet exercised live: the generated-title call against the real
  Z.AI endpoint (covered by mocked tests only) — it needs a `./dev`
  restart to load `lib/titles.ts` into the eve runtime.
