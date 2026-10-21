/**
 * 0055 v7: modes are owner-defined, freely, in a skill's own markdown —
 * no hardcoded mode or phase ids. This module is the pure core: parsing
 * a mode skill's body into `{brief, shared, phases}`, the generic
 * transition rule over whatever phases THIS skill declares, and the
 * per-turn note text. Deliberately dependency-free (no db import) so
 * workflow-body files (`workflows/chat/instructions.ts`,
 * `workflows/chat/turn.ts` — both must stay free of db imports, even
 * transitively, same as `lib/usage/pricing.ts`) can import it directly.
 */

/** Is this skill a MODE (sticky, phased) rather than an ordinary thread
 *  skill? Driven entirely by the skill's own `mode` flag now — no id
 *  hardcoding (0055 v5 compared against a fixed "ticket" id; v7 lets
 *  the owner define any number of modes in Settings). */
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
const PHASE_LABEL_RE = /^phase:\s*(.+)$/i;

type Section = { kind: "brief" } | { kind: "shared" } | { kind: "phase"; id: string; name: string };

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
    const heading = HEADING_RE.exec(line);
    if (!heading) {
      buffer.push(line);
      continue;
    }
    flush();
    const label = heading[1]!.trim();
    const phaseMatch = PHASE_LABEL_RE.exec(label);
    if (phaseMatch) {
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

export interface TransitionResult {
  ok: boolean;
  code?: "unknown-phase" | "same-phase" | "needs-note" | "no-phases";
  message?: string;
}

const ok: TransitionResult = { ok: true };

function refuse(code: NonNullable<TransitionResult["code"]>, message: string): TransitionResult {
  return { ok: false, code, message };
}

function phaseNames(phases: readonly ModePhase[]): string {
  return phases.map((p) => p.name).join(", ") || "none";
}

/**
 * Pure transition validity over THIS skill's declared phases (no more
 * hardcoded rules — v5's fixed review→ship / fixup⇄review exceptions
 * and the plan gate are both gone; a mode's own phase order is all
 * there is). `to` matches a declared phase by id or name,
 * case-insensitively; unknown names the declared ones so a renamed
 * heading degrades to a clear message. The very next phase in document
 * order needs no note; anything else (back, skip, a loop) does.
 */
export function validateTransition(phases: readonly ModePhase[], fromId: string, to: string, note?: string): TransitionResult {
  const target = findPhase(phases, to);
  if (!target) return refuse("unknown-phase", `no such phase "${to}" — declared phases: ${phaseNames(phases)}`);
  if (target.id === fromId) return refuse("same-phase", `already in ${target.name}`);
  const fromIndex = phases.findIndex((p) => p.id === fromId);
  const toIndex = phases.findIndex((p) => p.id === target.id);
  if (fromIndex >= 0 && toIndex === fromIndex + 1) return ok;
  return note?.trim() ? ok : refuse("needs-note", `moving to ${target.name} needs a note explaining why`);
}

/**
 * Adopting a thread with no current phase to validate a transition from
 * — either a legacy thread (mode skill bound before `mode_phase`
 * existed) or one that entered a then-phaseless mode. Any declared
 * phase is reachable, but a note is required (there's no prior phase
 * for the agent to be reasoning from, so it must state where it is).
 */
export function checkLegacyAdopt(phases: readonly ModePhase[], to: string, note?: string): TransitionResult {
  if (phases.length === 0) return refuse("no-phases", "this mode has no phases");
  const target = findPhase(phases, to);
  if (!target) return refuse("unknown-phase", `no such phase "${to}" — declared phases: ${phaseNames(phases)}`);
  if (!note?.trim()) {
    return refuse("needs-note", "adopting this thread into a phase needs a note saying where it actually is");
  }
  return ok;
}

/**
 * Refusals for entering a mode (shared by the `enter_mode` tool and the
 * owner-entry send path): already in a mode (a real phase or the
 * phaseless-entry "" sentinel, see `conversations.mode_phase`'s schema
 * comment), or any other skill already bound — mode entry and skill
 * binding don't mix.
 */
export function checkEnterMode(current: { skill: string | null; modePhase: string | null }): { ok: true } | { ok: false; message: string } {
  if (current.modePhase != null) return { ok: false, message: "already in a mode" };
  if (current.skill) return { ok: false, message: `already running the "${current.skill}" skill — binding is the owner's` };
  return { ok: true };
}

/** `## <Name>\n\n<body>` — a phase's section, heading reattached. What
 *  `advance_phase` hands back (Shared is NOT resent; the orchestrator
 *  already has it from entry). */
export function renderPhaseSection(phase: ModePhase): string {
  return `## ${phase.name}\n\n${phase.body}`.trim();
}

/** "Phases: A → B → C" — the phase list line shown on entry. */
export function renderPhaseList(phases: readonly ModePhase[]): string {
  return `Phases: ${phases.map((p) => p.name).join(" → ")}`;
}

/** What the orchestrator sees on entry (appended row / `enter_mode`
 *  result): brief + phase list + Shared + the first phase's section.
 *  Gracefully drops whatever a phaseless or Shared-less mode doesn't have. */
export function renderModeEntry(parsed: ParsedModeSkill): string {
  const parts = [parsed.brief];
  if (parsed.phases.length > 0) parts.push(renderPhaseList(parsed.phases));
  if (parsed.shared) parts.push(`## Shared\n\n${parsed.shared}`);
  if (parsed.phases.length > 0) parts.push(renderPhaseSection(parsed.phases[0]!));
  return parts.filter((p) => p.trim()).join("\n\n").trim();
}

/** `[thread state] mode: ticket · phase: qa (3/5) · next: ship` — the
 *  per-turn reminder. The rendered STRING is what gets stored as row
 *  metadata (`db/chat.ts`'s `listTurnMessages` just replays it verbatim
 *  — no parsing on rebuild, so it stays byte-stable turn over turn). */
export const THREAD_STATE_PREFIX = "[thread state]";

export function threadStateNote(modeId: string, phases: readonly ModePhase[], currentId: string): string {
  const index = phases.findIndex((p) => p.id === currentId);
  const current = index >= 0 ? phases[index]! : null;
  const position = index >= 0 ? index + 1 : 0;
  const next = index >= 0 && index + 1 < phases.length ? phases[index + 1]!.name : "done";
  return `${THREAD_STATE_PREFIX} mode: ${modeId} · phase: ${current?.name ?? currentId} (${position}/${phases.length}) · next: ${next}`;
}
