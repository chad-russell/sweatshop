# 0015 — Agent everywhere: machine tools and an always-available agent panel

Status: **approved (2026-10-02)** — the panel toggle floats bottom-right.

## Goal

1. **Agents can create and change machines.** Every chat gets tools to
   list, read, create and edit machine definitions, built on 0014's edit
   operations. Any conversation can then build or rework a machine,
   whether it is a full-page chat, a project chat, the panel below, or an
   agent stage in a run.
2. **One agent, available on every page.** A panel in the root layout,
   in the style of Vercel's and Linear's built-in agents, opens over
   whatever page you are on. Each message carries the page's context, so
   "make this stage loop back to plan" works without naming the machine.
   It is not a separate kind of assistant: it is an ordinary chat with
   the ordinary tools, shown in a different frame.

This replaces the "bespoke LLM-assisted machine editor" idea from 0012's
brainstorm. Assisting with machines becomes **tools + page context +
the panel**, and the same three give help on runs, sandboxes and
everything else for free.

## Why

Chad, 2026-10-02: an always-available agent "merges the concept with
just normal tools being called by an agent, like it could also be
anywhere else". A machine-only assistant would duplicate the chat
runtime, its tools, approvals and history for one page.

Read on 2026-10-02:

- **The chat runtime is already general.** `buildChatTools`
  (`workflows/chat/tools.ts`) is per-conversation, tool steps touch
  sqlite, `ask_chad` suspends a turn on a hook, and the chat route
  (`/api/x/chat`) creates a conversation on its first send. The panel
  needs no new runtime.
- **The edit surface exists.** `lib/machines/edit.ts` is pure,
  data-shaped and already unit-tested, and `updateMachine` validates and
  bumps `version`.
- **What is missing:** machine tools; any notion of "where the user is"
  reaching the agent; and a chat surface that can render somewhere other
  than a full page. `ChatSurface` (`components/chat.tsx`, about 1,150
  lines) is page-coupled: an `h-dvh` frame, a URL rewrite on adopt
  (`replaceState` to `/c/<id>`), and new-chat navigation.

## Part A — Machine tools

### Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Tool set | `list_machines` (id, name, description, workspace, version, stage count), `get_machine` (the full definition + version), `create_machine` (`{ id?, name, description?, definition }`), `edit_machine` (`{ id, baseVersion, ops[], name?, description? }`), `delete_machine`. All are added to every chat (no sandbox or project needed). `start_machine` keeps its listing mode for "what can I run here". | The smallest set that covers read, create, change and remove. Listing stays separate from `get_machine` so the agent does not pull every definition into context. |
| `edit_machine` ops | A discriminated union mirroring `lib/machines/edit.ts` one to one: `add_stage`, `update_stage`, `set_kind`, `rename_stage`, `remove_stage`, `connect`, `disconnect`, `update_transition`, `set_start`, `set_workspace`. Applied **in order to the saved definition, all or nothing**: the result is validated once with `parseDefinition`; if it is valid it is saved (version + 1); if not, nothing is saved and the tool returns the issues **by element** (`issuesByElement`) together with the resulting draft's shape, so the model can repair its batch. | The ops are already the editor's contract, so the agent and the human edit through the same functions. A batch can pass through invalid intermediate states, just as the editor can. All-or-nothing means a partial batch never lands. |
| Whole-definition replace | `create_machine` takes a full definition (generation). `edit_machine` has **no** replace op. | Generating means writing a definition. Changing one means ops, so small edits stay small and reviewable, and the agent cannot silently rewrite a machine it only meant to touch. |
| Conflicts | `edit_machine` requires `baseVersion` and fails with `conflict` (current version included) when the machine has moved on. The agent then re-reads and retries. | Optimistic concurrency. A save from Chad's editor between the agent's read and its write is never overwritten. |
| Approvals | Create and edit run **without** approval. Delete asks first, through `ask_chad` inside the tool (the same hook suspension, so it shows in the Inbox). | Runs freeze a snapshot, so an edit cannot break a running run, and every edit bumps the version, so a bad one is visible. Delete is the one irreversible action (runs keep their snapshot, the machine row goes). |
| Ids and limits | Tool input reuses the store's rules (`MACHINE_ID`, `cleanName`, `MachineError`). Errors return as tool results (`{ ok: false, code, message, issues? }`), not thrown, so the model reads them. | One set of rules, and the model can recover. |
| Where the code lives | `lib/agent/tools/machines.ts`: plain functions over `db/machines.ts` + `lib/machines/edit.ts`, wrapped as steps in `workflows/chat/steps.ts` like `inspect`. A small `applyOps(def, ops)` lives in `lib/machines/edit.ts`, pure and tested. | It follows the existing tool-core pattern. `applyOps` is also what the editor's future "apply a proposal" would use. |
| Editor sync | The machine editor polls `GET /api/machines/<id>` for its `version` every 5 s while visible. A newer version **with no unsaved edits** reloads the draft silently. **With unsaved edits**, a banner offers "Reload (discard your changes)". | When the panel edits the machine you are looking at, you see it land. Your own unsaved work is never clobbered. |

### Tests

Unit tests: `applyOps` (op order, all-or-nothing, errors by element);
the tool cores against a temp db (create, edit success with a version
bump, invalid batch saves nothing and returns issues, conflict on a stale
`baseVersion`, delete). A mock-LLM agent test follows the x-chat
pattern: a scripted model calls `edit_machine`, and the machine row
changes.

## Part B — The agent panel

### Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Shape | A **right-side panel** in the root layout, toggled from a button in the app shell (bottom-right) and by **⌘J** / Ctrl-J. It is resizable (~420 px by default), pushes the page on wide screens, and overlays it below `lg`. It stays open across navigation. | The panel sits next to what you're working on; a popover would cover it. ⌘J is free (⌘K is the palette). Staying open across pages is the point of having it everywhere. |
| What it is | An **ordinary chat**: a `conversations` row, the same chat route, tools, approvals, transcript store, sidebar listing, search and unread rules. The panel shows **one current conversation**. A "New" button starts a fresh one, and "Open full page" goes to `/c/<id>`. The current panel conversation's id lives in `localStorage`. | Chad: ordinary chats. They are searchable and filed like any other, and can graduate to the full page. There is no second history system. |
| Project scope | A conversation created from the panel binds to **the project of the page you are on** (`/p/<id>`, a project chat, a project run, a sandbox owned by a project chat), otherwise to none. Its sandbox follows 0013 (its own, created lazily, in project scope). After creation it never changes, even if you navigate. | Project-bound tools (pi, claude, create_pr) work when you start from a project page. 0013's "a bound conversation never switches sandboxes" holds. |
| Page context | Each send carries a small `context` object built from the route and its entities: `{ path, kind: "machine" \| "run" \| "chat" \| "project" \| "sandbox" \| "inbox" \| "other", ids…, title, selection? }`. The machine editor contributes the selected stage or edge, and the run view the run status and current stage. The route renders it as a **system note** on the turn, ``Chad is viewing <kind> <title> (`<id>`)…``, stored on the user message row as metadata, not as text. Without context, nothing is added. | "This" resolves without Chad naming ids. As metadata, it is visible in the transcript (a small "viewing …" chip on the message) but never pollutes search or titles. Ids, not page contents: the agent fetches what it needs with `get_machine` / `inspect`, so context stays tiny and current. |
| Context plumbing | A client `PageContext` provider in the root layout. Pages register their context with a hook (`usePageContext({ kind: "machine", id, title, selection })`). The panel reads it at send time. Unregistered pages fall back to `{ path, kind: "other" }`. | Pages own what "this" means on them. Nothing is scraped from the DOM. |
| Instructions | `chatTurn` gains one line in its instructions about the context note ("when a viewing note is present, 'this' refers to it"), and the machine tools carry their own descriptions. There is no panel-specific persona. | One agent. |
| Chat surface split | `ChatSurface` is refactored into a **`ChatSession`** (transcript + composer + transport + approvals, frame-agnostic, with `onAdopted(id)` instead of URL rewrites) and two frames: the existing **page frame** (header, model and sandbox pickers, URL behaviour, new-chat key) and a new **panel frame** (compact header: title, New, Open full page, close). The machine-run target picker stays page-frame only. | It is the same transcript rendering and approval cards in both places; only the chrome differs. It is a refactor first (behaviour-preserving, page frame unchanged), then the panel. |
| Marking seen | Panel conversations mark themselves seen while the panel is open and the tab is focused, by the same `useMarkSeen` rule. | It is the same unread semantics as a full-page chat. |
| Mobile | Below `md`, the panel is a full-screen sheet. | That is the only sane shape on a phone. |

### Out of scope (Part B)

- The agent proposing edits as an on-canvas preview to accept or reject
  (a later step on top of `applyOps` and the editor's draft).
- Context beyond ids, title and selection (no page-content scraping).
- More than one panel conversation open at once (tabs).
- Voice, attachments in the panel (the page frame keeps whatever it has).

## Phases

1. **`applyOps` + tool cores** — `lib/machines/edit.ts` `applyOps`,
   `lib/agent/tools/machines.ts`, steps, registration in
   `buildChatTools`, `baseVersion` conflicts, and the delete approval.
   Unit tests plus the mock-LLM agent test.
2. **Editor sync** — version poll, silent reload when clean, a banner
   when dirty. Verified live by editing from a full-page chat while the
   editor is open.
3. **Chat surface split** — `ChatSession` + page frame, behaviour-
   preserving (every current chat page, the composer target picker, the
   0012 redirects and the 0013 binding picker are unchanged; existing
   tests stay green).
4. **Page context** — the provider, the `usePageContext` registrations
   (machine editor with selection, run view, chat, project, sandbox,
   inbox), `context` on the chat route, the system note, message
   metadata, and the "viewing …" chip.
5. **The panel** — the layout panel, toggle and ⌘J, the panel frame,
   project-scope creation, persistence of the current conversation, New
   and Open full page, mobile sheet, mark seen.
6. **Verify live** — from the ticket machine's editor, ask the panel to
   "add a lint stage after implement that loops back on failure". The
   graph updates in place, the version bumps, and the panel conversation
   shows in the sidebar with its "viewing" chip. Then from a run, "why
   did this fail?" uses `inspect` on the run in context.

## Resolved questions

1. The panel's toggle button **floats bottom-right**, always visible,
   rather than living in the sidebar footer — it is reachable from every
   page, including when the sidebar is collapsed on mobile. (Chad,
   2026-10-02.)
