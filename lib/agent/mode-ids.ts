/**
 * 0055 v7: modes are owner-defined, freely, in a skill's own markdown —
 * no hardcoded mode or phase ids. This module is the pure core: parsing
 * a mode skill's body into `{brief, shared, phases}`, the phase
 * handoff a worker receives, and the entry text. Deliberately
 * dependency-free (no db import) so
 * workflow-body files (`workflows/chat/instructions.ts`,
 * `workflows/chat/turn.ts` — both must stay free of db imports, even
 * transitively, same as `lib/usage/pricing.ts`) can import it directly.
 */

/** Is this skill a MODE (phased) rather than an ordinary thread skill?
 *  Driven entirely by the skill's own `mode` flag — no id hardcoding. */
export function isModeSkill(mode: boolean | null | undefined): boolean {
  return mode === true;
}

export interface ModePhase {
  /** Slug of the declared name: lowercase, non-alphanumeric runs → "-",
   *  leading/trailing dashes trimmed (e.g. "Write docs!" → "write-docs"). */
  id: string;
  /** The free-text name as written after "Phase:" (e.g. "QA", "Write docs"). */
  name: string;
  /** The section's content, heading excluded. */
  body: string;
}

export interface ParsedModeSkill {
  /** The H1, the text before the first `##`, and any other `##` section
   *  (in document order) — read only by the thread running the mode. */
  brief: string;
  /** The `## Shared` section's content, heading excluded; null if absent. */
  shared: string | null;
  /** Declared `## Phase: <Name>` sections, in document order. A later
   *  heading whose name slugs to an id already seen is dropped entirely
   *  (first wins, nothing else about the duplicate is exposed). */
  phases: ModePhase[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Matches a `## ` heading line, excluding `###` and deeper. */
const HEADING_RE = /^##(?!#)[ \t]+(.*\S)\s*$/;
/** "Phase: Name" or "Phase : Name" — whitespace before the colon is tolerated. */
const PHASE_LABEL_RE = /^phase\s*:\s*(.+)$/i;

type Section = { kind: "brief" } | { kind: "shared" } | { kind: "phase"; id: string; name: string };

/** The fence character a ``` or ~~~ line opens/closes (3+ of the same
 *  character; CommonMark doesn't cross-close a ``` fence with ~~~). */
function fenceChar(line: string): "`" | "~" | null {
  const trimmed = line.trimStart();
  if (/^`{3,}/.test(trimmed)) return "`";
  if (/^~{3,}/.test(trimmed)) return "~";
  return null;
}

/**
 * Parse a mode skill's body (front matter already stripped) into its
 * brief, optional Shared block, and declared phases. One pass: each
 * `## ` heading (not `###`+) starts a new section running to the next
 * one; `## Phase: <Name>` (case-insensitive "Phase:") declares a phase,
 * `## Shared` (case-insensitive) is shared context, everything else —
 * including the text before the first heading — joins the brief.
 */
export function parseModeSkill(body: string): ParsedModeSkill {
  const lines = body.split("\n");
  const briefParts: string[] = [];
  let shared: string | null = null;
  const phases: ModePhase[] = [];
  const seenPhaseIds = new Set<string>();

  let current: Section = { kind: "brief" };
  let buffer: string[] = [];
  let fence: "`" | "~" | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (current.kind === "brief") {
      if (text) briefParts.push(text);
    } else if (current.kind === "shared") {
      if (shared === null && text) shared = text; // first "## Shared" wins
    } else if (!seenPhaseIds.has(current.id)) {
      seenPhaseIds.add(current.id);
      phases.push({ id: current.id, name: current.name, body: text });
    } // else: duplicate phase id — silently dropped, nothing exposed
  };

  for (const line of lines) {
    const ch = fenceChar(line);
    if (fence) {
      // Inside a fenced code block: every line is content, including
      // anything that would otherwise look like a `##` heading — only
      // the SAME fence character (3+) closes it, same as CommonMark.
      buffer.push(line);
      if (ch === fence) fence = null;
      continue;
    }
    if (ch) {
      fence = ch;
      buffer.push(line);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const label = heading[1]!.trim();
    const phaseMatch = PHASE_LABEL_RE.exec(label);
    // A name that slugs to "" (e.g. "!@#", punctuation only) would
    // collide with the phaseless-mode sentinel ("" means "entered, no
    // phases" on conversations.mode_phase) — treat it as ordinary brief
    // content instead of a declared phase, same as any other non-phase
    // `##` heading.
    if (phaseMatch && slugify(phaseMatch[1]!.trim())) {
      const name = phaseMatch[1]!.trim();
      current = { kind: "phase", id: slugify(name), name };
    } else if (/^shared$/i.test(label)) {
      current = { kind: "shared" };
    } else {
      current = { kind: "brief" };
      buffer.push(line); // a brief section keeps its own heading as content
    }
  }
  flush();

  return { brief: briefParts.join("\n\n").trim(), shared, phases };
}

/** Find a declared phase by id or case-insensitive name. */
export function findPhase(phases: readonly ModePhase[], to: string): ModePhase | null {
  const lower = to.toLowerCase();
  return phases.find((p) => p.id === lower || p.name.toLowerCase() === lower) ?? null;
}

/** `## <Name>\n\n<body>` — a phase's section, heading reattached. */
export function renderPhaseSection(phase: ModePhase): string {
  return `## ${phase.name}\n\n${phase.body}`.trim();
}

/** "Phases: A → B → C" — the phase list line shown on entry. */
export function renderPhaseList(phases: readonly ModePhase[]): string {
  return `Phases: ${phases.map((p) => p.name).join(" → ")}`;
}

/** Suggested `update_status` steps for a mode's declared phases. Empty
 *  when the mode declares none. */
export function renderStatusSeed(phases: readonly ModePhase[]): string {
  if (phases.length === 0) return "";
  const steps = phases.map((phase, index) => `${phase.name} (${index === 0 ? "active" : "pending"})`).join(", ");
  return (
    `Seed update_status with these steps — the active one is the current phase: ${steps}. ` +
    "Call update_status again whenever the step changes."
  );
}

/** What the orchestrator sees on owner entry: brief + phase list +
 *  Shared + the first phase's section, then the status seed. Gracefully
 *  drops whatever a phaseless or Shared-less mode doesn't have. */
export function renderModeEntry(parsed: ParsedModeSkill): string {
  const parts = [parsed.brief];
  if (parsed.phases.length > 0) parts.push(renderPhaseList(parsed.phases));
  if (parsed.shared) parts.push(`## Shared\n\n${parsed.shared}`);
  if (parsed.phases.length > 0) parts.push(renderPhaseSection(parsed.phases[0]!));
  const seed = renderStatusSeed(parsed.phases);
  if (seed) parts.push(seed);
  return parts.filter((p) => p.trim()).join("\n\n").trim();
}

/** The line `renderPhaseHandoff` puts before the orchestrator's task. */
export const PHASE_HANDOFF_TASK_MARKER = "\n---\nTask from the orchestrator:\n";

/** Split a worker's first message into the prepended phase handoff and
 *  the orchestrator's task. Null when the text is not a handoff. */
export function splitPhaseHandoff(text: string): { phase: string; context: string; task: string } | null {
  const match = /^You are doing the "([^"]+)" phase of a "[^"]+" run\./.exec(text);
  if (!match) return null;
  const index = text.indexOf(PHASE_HANDOFF_TASK_MARKER);
  if (index < 0) return null;
  return {
    phase: match[1]!,
    context: text.slice(0, index).trim(),
    task: text.slice(index + PHASE_HANDOFF_TASK_MARKER.length),
  };
}

/**
 * 0055 v7 part B: the runtime-attached handoff a phase WORKER (a harness
 * call or start_thread child started in a moded chat) gets — never the
 * brief (addressed to the orchestrator) and never the other phases, just
 * this one plus whatever Shared context every phase needs, and the
 * orchestrator's own task last. `modeName` is the skill's display title
 * (its H1, or its id — resolved by the caller, e.g. via
 * lib/skill-files.ts's `deriveSkillTitle`); `shared`/`phase.body` are
 * inserted verbatim, no heading re-attached (the opening line already
 * names the phase). Owner placeholders are rendered by the caller.
 */
export function renderPhaseHandoff(input: { modeName: string; phase: ModePhase; shared: string | null; task: string }): string {
  const header =
    `You are doing the "${input.phase.name}" phase of a "${input.modeName}" run. Do only this phase; ` +
    "other phases are handled separately. Your result goes back to the orchestrator.";
  const parts = [header];
  if (input.shared) parts.push(input.shared);
  if (input.phase.body) parts.push(input.phase.body);
  parts.push(`---\nTask from the orchestrator:\n${input.task}`);
  return parts.join("\n\n");
}
