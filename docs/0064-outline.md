# 0064 — Outline: one step tree for goal, plan, status and to-dos

Status: **approved in chat (plan v3, 2026-10-21).** Supersedes 0055
(modes, phases, phase handoff, mode chip), 0059 decisions 1 and 6
(mode skills seeding status; skill-version phase context), and 0041's
PLAN.md parts (the file, `present_plan`, the checklist count, the line
diff). Keeps 0041's non-blocking review + explicit approval, and 0059's
"derived from the transcript, never stored".

## Why

Three trackers answer one question, "where is this thread and what's
next?":

- **Modes (0055):** phases are hardcoded per skill in Settings, with
  `mode_phase`/`work_phase` columns, a handoff parser, entry rows and a
  composer chip. About 1,600 lines in dedicated files, plus branches
  through the turn, the instructions, `start_thread` and harness start.
- **Plan files (0041):** prose in a sandbox file, its own approval, a
  checklist that is rarely re-presented. About 1,100 lines.
- **Status (0059):** `update_status`, a whole-tree rewrite derived from
  the transcript. About 430 lines. This one works and reads well.

Phases should be invented per task, not declared in a skill. The plan
should be concise and skimmable. Status should be the plan, kept current.
So: one concept.

## Decisions

1. **One outline per thread**, written by one tool, `update_outline`
   (whole-tree rewrite, TodoWrite-style). The current outline is the last
   snapshot in the transcript and the history is all of them. No table.

   ```ts
   Outline = { goal: string; steps: Step[]; note?: string }
   Step = {
     id: string;            // stable agent-chosen slug, kept across rewrites
     label: string;
     state: "pending" | "active" | "done" | "skipped" | "blocked";
     detail?: string;
     children?: Step[];     // any depth; caps: depth 4, 200 nodes
     runner?: Runner;       // top-level steps only
   }
   Runner = "auto" | "self" | "thread" | HarnessRoute   // default "auto"
   ```

   `HarnessRoute` is 0021's existing value (pi/claude/cursor/codex plus
   model and effort/thinking), validated by `validateRoute`. Project
   `allowed_harnesses`/`allowed_providers` apply.
2. **Concise.** No brief and no prose document. `goal` is the one-line
   summary; `detail` on any node carries what the agent needs.
3. **Only top-level steps execute.** A top-level step is the unit of
   delegation and the only place a runner lives. Children at any depth are
   the to-do list for whoever does that step. There is no per-node
   execution, scheduling, or parallelism.
4. **Runners are hard rules unless `auto`.** While a top-level step is
   active, code enforces its runner:
   - **HarnessRoute:** that harness tool runs that exact route. Another
     harness, a different model, or `start_thread` is refused value-shaped,
     and the refusal names the runner.
   - **`thread`:** only `start_thread` delegates.
   - **`self`:** no delegation.
   - **`auto`:** unrestricted (today's behavior).

   Changing a runner means editing the outline.
5. **Review never blocks.** `update_outline({..., propose: true})` opens a
   hookless `pending_inputs` row of kind `outline` (0041's mechanism,
   renamed). A newer proposal supersedes the open one. Approval is
   explicit only: the card's Approve, or the approval-gated
   `accept_outline` when Chad says "go" in chat. Approval wakes the
   conversation.
6. **Chad can edit the card**: labels, add/delete/reorder at any depth,
   and the runner picker on top-level steps. Editing is open while a
   proposal is in review; afterwards only pending steps' runners stay
   editable. An edit is a user row with `metadata.runEvent: "outline-edit"`
   carrying the full tree, rendered as a chip, and the derivation treats it
   as a snapshot. Approve with edits is one edit row plus approval, in one
   wake.
7. **The orchestrator owns the outline.** A worker (harness call or child
   thread) started while a step is active gets the goal and that step's
   subtree prepended to its task. This replaces 0055's phase handoff. The
   call records the step label (`harness_calls.step`;
   `conversations.work_step` for a child). Cards and sidebar show
   `<step> · <harness> (<model>)`.
8. **Reminders.** The per-turn `[thread state]` note (rendered once,
   replayed verbatim, cache-stable as 0055 established) carries the goal,
   the active step plus its runner and open children, the next step plus
   its runner, and "if this changed, call update_outline". Wakes carry the
   active step. A wake followed by a completed turn with no
   `update_outline` marks the outline stale (0059 behavior, unchanged).
9. **Skills are runbooks only.** No `mode` flag, no phases, no mode entry
   on send, no mode chip. `use_skill` loads text. `ticket` becomes prose
   ("propose an outline, typically Plan → Implement → Review → Ship").
   The composer's mode chip shrinks to a "N working" live-work chip.
10. **Legacy read-compat.** Existing `update_status` results still derive,
    as outlines with no goal, ids from labels, and runner `auto`. Old
    `present_plan` cards keep rendering read-only. Nothing is rewritten in
    place.

## UI

One card, the 0059 status card grown: the goal on top, a collapsible tree,
runner badges on top-level steps, and a "changes since vN" toggle diffed by
step id. In review it shows Approve and edit controls. The header chip
reads `<active step> · d/n`, `needs you` (blocked or in review), or a PR
state (0052 wins). The Inbox shows an open proposal.

## Later (designed for, not built)

- **Workers refine their own step:** a scoped `refine_step(id, children)`
  that may touch only the subtree the worker was handed, landing as a
  snapshot in the parent transcript. Stable ids exist now so this needs no
  reshaping.
- **Outline history as memory:** a finished step's subtree plus its
  worker's result as a compaction unit and search index.
- **Owner-started outlines** from the composer.

## Not doing

A table for outlines, percentages or ETAs, phase-order gates, per-node
runners, keeping PLAN.md.

## Build steps

- **PR 1 — the tree:** `lib/outline.ts` (pure: types, validate, derive
  with legacy compat, chip, thread-state note), `update_outline`
  (replacing `update_status`), propose/supersede/approve on
  `pending_inputs`, `accept_outline`, read-only card, header chip, Inbox.
  Mock-LLM tests: propose does not suspend, approve wakes, stale
  detection, legacy derivation.
- **PR 2 — editing and runners:** editable card plus runner picker,
  `outline-edit` rows, `/api/x/input` edit+approve, runner enforcement in
  the harness tools and `start_thread`, worker step subtree,
  `harness_calls.step`. Tests: pinned route, each refusal, `auto`
  passthrough, allow-list refusal, stale-version refusal.
- **PR 3 — deletion:** modes (`mode-ids`, `mode-entry`, `mode-chrome`,
  `phase-handoff`, `phase-context`, `/api/x/mode`, mode chip → work chip,
  Settings checkbox and preview, `mode:` send param), the PLAN.md path
  (`present_plan`, checklist, LCS diff, plan card), and the migration
  dropping `mode_phase`, `work_phase`, `phase_skill_*`, `phase_id`,
  `skills.mode` (`harness_calls.phase` → `step`). Rewrite `ticket`,
  update the base prompt, system_docs and AGENTS.md. Before/after
  screenshots and the real line count.
