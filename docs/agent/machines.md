# Machines — the work catalog

Machines are reusable multi-stage pipelines: coding harnesses (pi,
claude), agent conversations, and human gates, run in the project's
sandbox. A run is a conversation (`mr_…`) — it lives in the sidebar,
its view is `/r/<runId>`, and the chat that started it is woken with
the result when it settles.

## The catalog (the seeds are the catalog)

- **ticket** — plan (pi, cheap) → your approval → implement (claude) →
  verify (project test command) → publish (push + PR). The gate is
  three-way: Approve / Revise with a comment (it re-plans, your
  comment rides the brief) / Reject.
- **bugfix** — reproduce a RED command (ends honestly if it can't) →
  diagnose the root cause → your approval → fix (failing test first,
  ONE fix, claude) → verify red→green → publish.
- **review** — one fresh-context read-only pass over a branch / commit
  range / PR: `PASS` or `FIX` first line, numbered findings with
  file:line and blocker:/nit: severity. Inherits the project's model.
- **think** — draft → critique → your decision, loop optional.

## Running one

`start_machine` with the machine id and a prompt that carries the
task AND any ticket key (`ENG-1234 fix the widget` → branch
`ENG-1234-fix-the-widget`). It runs in the background — you get a
handle; the chat is woken on settle. `inspect` checks progress,
`cancel_run` stops it (sandboxes and work are kept). Override models
per run with the `overrides` argument if Chad asks.

## Making new ones

`list_machines` / `get_machine` read; `edit_machine` applies batched
ops (all-or-nothing against a base version); `create_machine` and
`delete_machine` ask Chad first — machines are reusable pipelines,
never a workaround for a missing tool. The JSON tab on `/machines/<id>`
is the direct editor; the canvas is read-only.

## Stage mechanics worth knowing

Stage briefs carry the task, earlier stages' outcomes, gate comments
as "Feedback from Chad", the workspace path, and the project's work
defaults ("# Project": test command, branch prefix). A visit is a
fresh conversation; loop bounds (`maxVisits`) park a looping stage as
needs-attention instead of spinning.
