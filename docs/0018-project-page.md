# 0018 — The project page: a project's home; new chat split out

Status: **approved in chat 2026-10-05 (shape + both forks — `/?project=`
for new chat, read-only first); phases 1–2 shipped same day**

## Phase 3 — cascade decided in chat 2026-10-05

- **Conversations hard-delete** in the project delete (typed-name
  confirm). Trash stays a conversation-level op — a deleted project
  leaves no dangling-group trashed rows.
- **Repo removal guards and refuses** with named blockers (the setup
  targets it, previews reference it); clearing them is deliberate,
  never a cascade side effect.
- **Cascade order:** cancel live machine runs → destroy live sandboxes
  (services die with them) → per-conversation
  `deleteConversationForever` (the purge pattern, including owned
  sandboxes' containers) → one transaction: the project's previews +
  events, sandbox calls/attachments, sandbox ROWS (deviation from
  0011's rows-stay: those rows exist as call-attribution history and
  the calls die here too), folders, preview setup, repos, the project.
  Untouched: machines (not project-owned), sandbox configs
  (shareable), git credentials (global by host).
- **CRUD scope:** rename; repo add (unique name per project) and
  guarded remove; config pick (none/existing) + shared field editing
  with a shared-with-N note; creating configs stays `db:seed` v1.

## Implementation notes (phases 1–2)

- Phase 2 deviation: the project page hosts the editor for setups
  that do not exist yet too ("Create setup"), so the save-without-
  launching capability is fully replaced there and the New-preview
  dialog is pure create ("Save setup only" deleted). A stored row
  that fails validation surfaces its issues above an empty editor.
- Phase 1 rider: ⌘K's run-machine action stopped building
  `/p/undefined` when invoked off a project page.

## Why

Follow-through on the 0017 amendment: a preview setup IS project
config ("how does this project run"), but its only editing surface
lived on `/previews`, so it reads as preview state — the exact
confusion that surfaced in review. The fix is placement, not a new
mechanism: the DB stays the single source of truth (the
repo-committed `.sweatshop/preview.json` idea stays the 0017
follow-up, deliberately not chosen — placement over portability for
now), and the project gets a real page instead of lending its URL to
a chat.

## The project page — `/p/[projectId]`

One scrolling page of cards (the sandbox-page pattern; no tabs):

- **Overview** — name; repos (url, which GitHost credential resolves);
  sandbox config (`image_ref`, `network_policy`). Read-only in phases
  1–2 (these are `db:seed`-managed today; phase 3 gives them editors).
- **Preview setup** — the full `SetupFields` editor, saving in place.
  This is the definition's permanent home. The New-preview dialog on
  `/previews` keeps its create-with-save flow (the same component at
  the first-fill moment) and loses its "Save setup only" footer
  action — `/p` is that action now.
- **Work surfaces** — links to the project's machines and previews
  (`/previews?project=` filter param added) so `/p` is the project's
  front door without duplicating the sidebar's conversation job.

## New chat — `/` is THE new-conversation page

The composer's target picker gains **projects** (chat-in-project)
beside machines (machine run); picking one binds the session exactly
as `/p` did (the same session-create header). `ChatSurface` gains
`initialProjectId` from the search param beside its existing
`initialMachineId`, and `/p` stops rendering a `ChatSurface` at all.

- Sidebar: the project-group name link becomes navigation to `/p`
  (today it starts a chat, titled "New conversation in…"); the group
  header gains a `+` that opens `/?project=<id>`.
- ⌘K and run-view composer links (`/p/<id>?machine=`) become
  `/?project=<id>&machine=<id>`.

## Explicitly not changing

- Conversation routes (`/c`, `/r`), sidebar conversation trees,
  folders, archive/trash.
- The setup's storage or schema — sqlite only, unchanged.
- `/previews` as the global list + the two-phase create.
- Project CRUD **cascade semantics** (what deleting a project does to
  conversations, sandboxes, previews, machines) — deliberately
  designed in phase 3, not before.

## Phases

1. **Skeleton + link flips + new chat.** The project page renders
   overview + work-surface links; `/?project=` works; sidebar name
   link, group `+`, ⌘K, and run-view links updated. No editor moves.
2. **Setup editor home.** `SetupFields` on `/p` with save; the
   New-preview dialog slims to create; "Save setup only" deleted.
3. **Entity CRUD.** Rename project, add/remove repos, sandbox-config
   editing, delete project (the manual-SQL paper cut) — with the
   cascade written down and approved before any of it ships.

Each phase: typecheck/lint/test green; store-level tests where
behavior changes (mostly routes/UI in 1–2; phase 3 gets store tests).
