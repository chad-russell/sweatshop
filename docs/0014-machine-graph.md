# 0014 — Machine graph: view and edit definitions as a graph

Status: **proposed (2026-10-02)** — awaiting Chad's approval.
`@xyflow/react` itself was approved in chat on 2026-10-02.

## Goal

See a machine as what it is: a graph of stages with transitions. Today's
JSON is a flattened version of that graph. This doc covers three things:

- the machine page draws the definition as a graph and edits it there;
- the run view draws the same graph with the run's progress over it;
- every edit, whether from the graph or a form, goes through the one
  validator the store uses.

This is the second of the three steps from the 0012 brainstorm. The
third, LLM-assisted editing and generation of machines, gets its own doc
(0015). It is designed against the edit operations defined here, so
those are kept small and data-shaped on purpose.

## Why

Read on 2026-10-02 (after 0013):

- **Editing is a JSON textarea** (`components/machines/machine-editor.tsx`).
  Errors come back as zod paths like `stages.verify.next.1.to`. Branches
  and loops, the very things machines exist for, are invisible until you
  trace `next` arrays by hand.
- **The run view is a list.** A loop (verify → implement → verify) shows
  as repeated cards, with no picture of where the run is in the machine
  or which way it can still go.
- **The definition has no positions.** It is pure semantics, and should
  stay that way for the interpreter.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Renderer | **`@xyflow/react`** (React Flow 12), with AI Elements' `canvas`, `node`, `edge`, `controls` and `panel` added through the registry into `components/ai-elements/`. | Approved dependency. AI Elements already styles these on our shadcn tokens, and copying them in keeps them editable like the other elements. |
| Layout | **Automatic, no stored positions.** A small in-house layered layout (`lib/machines/layout.ts`, pure, unit-tested): longest-path ranks from `start`, back edges (loops) found by DFS and drawn as returning curves, barycenter ordering within ranks. Nodes are not draggable. | Graphs are at most 30 stages × 8 transitions, which is a problem a hundred lines solve. That avoids a second dependency (dagre is 1.4 MB with graphlib; elk is 8 MB), keeps the definition schema unchanged (no `layout` block for runs to snapshot or seeds to carry), and an LLM edit (0015) never has to invent coordinates. If hand placement is ever wanted, an optional `layout` block can come later without breaking anything. |
| One source of truth | The editor holds **one draft `MachineDefinition`**. The graph, the stage form and the JSON tab are all views of it. Every change is a pure **edit operation** (`lib/machines/edit.ts`): `addStage`, `updateStage`, `renameStage`, `removeStage`, `connect`, `disconnect`, `updateTransition`, `setStart`, `setWorkspace`. Each returns a new definition and is re-validated with `parseDefinition`. | One validator and no drift between views. The same operations are the tool surface for 0015's assistant. |
| Invalid drafts | Edits may produce an invalid draft (for example a dangling `start` while the graph is being rewired). Save is disabled until it validates. Each zod issue is placed on the stage or edge it names (`stages.<id>…` → that node; `stages.<id>.next.<i>` → that edge), with a list of the issues above the graph. | Editing a graph means passing through invalid states. Showing the error *on* the thing that is wrong is the point of a visual editor. |
| Terminal | `end` is a fixed, drawn node. Connecting to it adds `{ to: "end" }`. A stage with no `next` gets an implicit, dashed edge to `end`, which mirrors the interpreter (no `next` ends the run). | It makes "where does this finish" visible, including the implicit case. |
| Editing interactions | **Connect** by dragging from a node's source handle to a target. **Select** a node to open the stage form (kind, title, harness/model/thinking for its kind, instructions, maxVisits). **Select** an edge to edit `when`, or delete it. Toolbar: add a stage (by kind), set as start, delete. Keyboard Delete removes the selected node or edge. | These are the operations the schema has, and nothing more. |
| Renaming stage ids | `renameStage` rewrites every `next.to` and `start` that point at the old id. Ids are still kebab-case. | Ids are references, so renaming one must not leave dangling edges behind. |
| JSON stays | A "JSON" tab on the same editor is the escape hatch: paste or tweak, validated live. Switching tabs never loses edits. | Power use and bulk paste; also the fallback if the graph has a bug. |
| Run overlay | `/r/<runId>` shows the **run's snapshot**, not the live machine. The current stage is ringed (info, or warning at a gate). Visited stages carry a visit-count badge and their last status. Taken transitions are solid and animated while live (AI Elements `Edge.Animated`); untaken ones are muted. Clicking a node scrolls the timeline to its latest visit and opens its transcript panel (0012). | The timeline keeps the full history. The graph answers "where is it, and where can it go". |
| Placement | Machine page: graph-first editor (graph centre, stage form in a right panel, JSON tab). Run view: a collapsible graph strip above the timeline, about 220px high, fit to view. | The run view's main content stays the timeline and transcripts. |
| Client only | The graph modules are `"use client"` and loaded with `next/dynamic` (`ssr: false`), so React Flow never reaches the server bundle or blocks the run view's first paint. | React Flow measures the DOM, and server-rendering it buys nothing. |

## Phases

1. **Pure core** — `lib/machines/layout.ts` (ranks, back edges, order,
   coordinates) and `lib/machines/edit.ts` (the operations, including
   rename rewriting references, plus `issuesByElement` mapping zod paths
   to node and edge ids). Unit tests: every seed lays out with no
   overlaps, loops are found as back edges, each operation preserves
   validity where it should, rename rewrites references, and issues map
   onto the right elements.
2. **Read-only graph** — add `@xyflow/react` and the AI Elements
   components, plus a `MachineGraph` component (stage nodes per kind:
   harness, agent and human icons with badges; the `end` node; labeled
   edges). Shown on the machine page above the current JSON editor and
   on the run view with the run overlay.
3. **Graph editor** — the draft model, connect, select, the stage and
   transition forms, the toolbar, inline issues, and the JSON tab. The
   textarea-only editor is deleted.
4. **Polish and verify** — keyboard paths, theme check across
   `clickhouse`, `cal` and `nova`, the empty `/machines/new` starter as
   a graph, and live checks against the seeded machines and a real run.

## Out of scope

- Hand-placed or saved node positions (the possible later `layout` block).
- Parallel branches or fan-out (still out of the 0009 schema).
- LLM assistance (0015).
- Editing a run's snapshot (runs stay immutable).

## Open questions

1. Should stage instructions be edited in the side panel only, or also
   inline on the node (a short preview that expands)? Proposed: panel
   only. Nodes show the title, the kind, and the first line of the
   instructions, read-only.
