# Changelog

<!--
  Format (docs/0085-changelog.md, AGENTS.md): `## YYYY-MM-DD` date
  headings, newest first. Under each date, one bullet per entry, tagged
  `- **Added** …` / `- **Changed** …` / `- **Fixed** …`. Keep bullets
  short and written for Chad, not for engineers — one line, no jargon.
  Create the date heading if it's missing; don't backfill older dates.
-->

## 2026-10-29

- **Changed** Sidebar: projects are one draggable list, Chats is its own section below, and nesting lines up (no more Unfiled level).
- **Changed** Skills are now a bring-your-own catalog on S3-compatible storage, visible to every chat and mounted into pi, Claude and Codex runs; the agent can save skills with your one-click approval. Bound threads and the built-in runbooks are gone.

## 2026-10-28

- **Added** A quieter sidebar with collapsed empty sections, reorderable projects and folders, and a Recent view grouped by day and week.
- **Fixed** Sidebar dragging now accepts drops between rows; Projects and Recent are tucked into the Conversations menu.

## 2026-10-27

- **Fixed** Claude and Codex harness calls failing to start after the dependency update — the missing-lockfile workaround now also works in production builds.

## 2026-10-26

- **Added** in-app changelog.
