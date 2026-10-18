# 0049 — Read models out of `db/`

Status: **DRAFT — proposed 2026-10-18, not yet approved.**

## Why

Client components import view types straight from `db/` modules:
`db/attention.ts` (12 import sites), `db/organize.ts` (8),
`db/sandbox-view.ts` (6), `db/search.ts` (3). All are `import type`
(erased at build — no bundling hazard today), but the layering rule
"components never depend on the store layer" is unenforceable while
the types live there, and `db/` mixes two concerns: persistence
invariants and UI read models (`InboxData`, `SidebarData`,
`NeedsYouThread`, `SearchHit` are shapes a page draws, not rows a
store guards). Every future view file must know which concern it is
importing by memory.

## What moves (types only, queries stay)

- `db/attention.ts` → `lib/read-models/attention.ts`: `RequestOption`,
  `PendingRequest`, `AttentionState`, `Where` (the embedded base),
  `NeedsYouThread`, `NeedsYouPreview`, `UnreadThread`, `InboxData`.
- `db/organize.ts` → `lib/read-models/sidebar.ts`: `SidebarItem`,
  `AttentionCounts`, `FolderNode`, `SidebarGroup`, `ShelvedItem`,
  `SidebarData`, `AttentionFlags`.
- `db/search.ts` → `lib/read-models/search.ts`: `SearchHit`,
  `SearchOptions`.
- `db/sandbox-view.ts` → `lib/read-models/sandbox.ts`: `SandboxRef`,
  `SandboxState`, `ConversationSandboxView`, `SandboxSummary`,
  `SandboxUser`, `SandboxDetail`, `SandboxLink`.

Queries and their invariants stay exactly where they are; the db
modules import the types back (a dependency db → lib/read-models,
which is the same direction as db → lib/attachments today). Nothing
about runtime behavior changes — this is a type-relocation so the
boundary becomes checkable.

## The lint rule that makes it stick

After the move, add a `no-restricted-imports` override to
`eslint.config.mjs`:

    { files: ["components/**/*.tsx", "components/**/*.ts"],
      rules: { "no-restricted-imports": ["error",
        { paths: [{ name: "@/db", message: "read models live in @/lib/read-models" }] }] } }

 Components import types from `@/lib/read-models/*`; anything needing a
 query calls an API route (the existing pattern — components already
 never call stores directly, only types leaked).

## Deliberately NOT in scope

- Moving queries or stores (they are the invariants' home — 0007's rule
  that every invariant lives in `db/organize.ts` stays).
- `db/sandbox-view.ts`'s queries (they are store-shaped reads, not UI
  shaping).
- A barrel `lib/read-models/index.ts` (deep imports keep file-to-file
  tracing honest; a barrel invites re-bloat).
- Server-side importers (app routes, lib, tests) keep importing from
  `@/db/*` for BOTH types and queries — only the component boundary is
  being drawn.

## Plan

1. `refactor(read-models)`: move the four type groups; db modules
   re-import; 29 import-site updates (components + the type-only test
   imports that mirror them).
2. `chore(lint)`: the eslint override; fix the ~5 violations it finds
   (expected: components importing a value from db/ that isn't a type —
   each becomes an API call or moves; any real coupling found here is a
   finding for this doc, not a drive-by fix).
3. `docs`: AGENTS.md layering note gains the rule.

One PR, no behavior change, gates unchanged.
