/**
 * 0081: the structured `ask_owner` question — types, validation,
 * screenshot-evidence resolution, answer formatting/validation, and the
 * composer's typed-text mapping. Pure core (no db import, same rule as
 * lib/outline.ts/lib/status.ts) so both server (workflows/chat/tools/
 * core.ts, the step that resolves evidence, the /api/x/input route) and
 * client (components/question-form.tsx, the inbox/chat cards) import it
 * safely.
 */

export const QUESTION_TYPES = ["single", "multi", "rank", "text"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MAX_QUESTIONS = 4;
export const EVIDENCE_TEXT_MAX = 8_000;

// --- model input (pre-resolution) ------------------------------------

export type QuestionEvidenceInput =
  | { type: "code"; lang?: string; text: string }
  | { type: "diff"; text: string }
  | { type: "markdown"; text: string }
  | { type: "link"; url: string; label?: string }
  | { type: "screenshot"; path: string; label?: string };

export interface QuestionOptionInput {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  evidence?: QuestionEvidenceInput;
}

export interface StructuredQuestionInput {
  id: string;
  header: string;
  type: QuestionType;
  options?: QuestionOptionInput[];
  allowOther?: boolean;
}

// --- resolved / stored (lands in pending_inputs.card) -----------------

export type QuestionEvidence =
  | { type: "code"; lang?: string; text: string }
  | { type: "diff"; text: string }
  | { type: "markdown"; text: string }
  | { type: "link"; url: string; label?: string }
  | { type: "screenshot"; attachmentId: string; url: string }
  | { type: "screenshot"; unavailable: true };

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  evidence?: QuestionEvidence;
}

export interface StructuredQuestion {
  id: string;
  header: string;
  type: QuestionType;
  options?: QuestionOption[];
  /** Resolved default (true) applied — always present on a stored question. */
  allowOther: boolean;
}

export interface AskOwnerCard {
  kind: "ask_owner";
  context?: string;
  /** Present only when the ask carried structured sub-questions. */
  questions?: StructuredQuestion[];
}

export function isAskOwnerCard(value: unknown): value is AskOwnerCard {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "ask_owner";
}

export interface QuestionAnswer {
  /** Option ids; ordered top-to-bottom for `rank`. */
  selected?: string[];
  other?: string;
  youPick?: boolean;
}

// --- validation (business rules the zod shape can't express) ----------

type Fail = { ok: false; message: string };
const fail = (message: string): Fail => ({ ok: false, message });

/** Cross-question/option business rules a zod schema can't express
 *  (option counts by type, uniqueness, at-most-one recommended on
 *  `single`, no options on `text`). Called before anything is written —
 *  a failure here means no pending row, no card, no hook (like
 *  create_pr's invalid preview). */
export function validateStructuredQuestions(
  questions: readonly StructuredQuestionInput[],
): { ok: true } | Fail {
  if (questions.length === 0) return fail("questions must have at least one entry");
  if (questions.length > MAX_QUESTIONS) return fail(`at most ${MAX_QUESTIONS} questions per ask`);
  const qIds = new Set<string>();
  for (const q of questions) {
    if (qIds.has(q.id)) return fail(`duplicate question id "${q.id}"`);
    qIds.add(q.id);
    const options = q.options ?? [];
    if (q.type === "text") {
      if (options.length > 0) return fail(`question "${q.id}" is type text — options are not allowed`);
      continue;
    }
    if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
      return fail(`question "${q.id}" needs ${MIN_OPTIONS}-${MAX_OPTIONS} options (type ${q.type})`);
    }
    const optIds = new Set<string>();
    const optLabels = new Set<string>();
    let recommended = 0;
    for (const o of options) {
      if (optIds.has(o.id)) return fail(`question "${q.id}" has a duplicate option id "${o.id}"`);
      optIds.add(o.id);
      const label = o.label.trim().toLowerCase();
      if (optLabels.has(label)) return fail(`question "${q.id}" has a duplicate option label "${o.label}"`);
      optLabels.add(label);
      if (o.recommended) recommended += 1;
      if (o.evidence?.type === "link" && !/^https?:\/\//i.test(o.evidence.url)) {
        return fail(`question "${q.id}" option "${o.id}": link evidence must be an http(s) URL`);
      }
    }
    if (q.type === "single" && recommended > 1) {
      return fail(`question "${q.id}" is type single — at most one option may be recommended`);
    }
  }
  return { ok: true };
}

// --- screenshot evidence resolution ------------------------------------

export interface AttachResult {
  ok: boolean;
  id?: string;
  url?: string;
}

/** Resolve every `screenshot` evidence (sandbox path → attachment id/url)
 *  through the injected `attach` callback — pure over the IO, so it's
 *  testable against a fake. A failed attach never fails the whole ask:
 *  that one option's evidence becomes `{unavailable: true}`. */
export async function resolveStructuredQuestions(
  questions: readonly StructuredQuestionInput[],
  attach: (input: { path: string; label?: string }) => Promise<AttachResult>,
): Promise<StructuredQuestion[]> {
  const out: StructuredQuestion[] = [];
  for (const q of questions) {
    const options = q.options;
    if (!options) {
      out.push({ id: q.id, header: q.header, type: q.type, allowOther: q.allowOther ?? true });
      continue;
    }
    const resolvedOptions: QuestionOption[] = [];
    for (const o of options) {
      let evidence: QuestionEvidence | undefined;
      if (o.evidence?.type === "screenshot") {
        const result = await attach({ path: o.evidence.path, label: o.evidence.label });
        evidence = result.ok && result.id && result.url
          ? { type: "screenshot", attachmentId: result.id, url: result.url }
          : { type: "screenshot", unavailable: true };
      } else if (o.evidence) {
        evidence = o.evidence;
      }
      resolvedOptions.push({
        id: o.id,
        label: o.label,
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
      });
    }
    out.push({
      id: q.id,
      header: q.header,
      type: q.type,
      options: resolvedOptions,
      allowOther: q.allowOther ?? true,
    });
  }
  return out;
}

// --- server-side answer validation (against the stored spec) ----------

/** Cross-check a submitted answer set against the stored card before
 *  resuming the hook — unknown question/option ids, wrong shape for the
 *  type, all rejected here so an invalid POST never reaches the hook or
 *  mutates the pending row. */
export function validateAnswers(
  card: AskOwnerCard,
  answers: Record<string, QuestionAnswer>,
): { ok: true } | Fail {
  const questions = card.questions ?? [];
  if (questions.length === 0) return fail("this ask has no structured questions");
  for (const key of Object.keys(answers)) {
    if (!questions.some((q) => q.id === key)) return fail(`unknown question "${key}"`);
  }
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) return fail(`missing an answer for "${q.header}"`);
    const hasSelected = Boolean(a.selected && a.selected.length > 0);
    const hasOther = Boolean(a.other && a.other.trim());
    const modes = [Boolean(a.youPick), hasOther, hasSelected].filter(Boolean).length;
    if (modes === 0) return fail(`"${q.header}" has no answer`);
    if (modes > 1) return fail(`"${q.header}" was answered more than one way`);
    if (hasOther && !q.allowOther && q.type !== "text") return fail(`"${q.header}" does not accept a freeform answer`);
    if (a.youPick || hasOther) continue;
    if (q.type === "text") return fail(`"${q.header}" is freeform — it has no options to select`);
    const options = q.options ?? [];
    const ids = a.selected!;
    for (const id of ids) {
      if (!options.some((o) => o.id === id)) return fail(`"${q.header}" has an unknown option "${id}"`);
    }
    if (new Set(ids).size !== ids.length) return fail(`"${q.header}" repeats an option`);
    if (q.type === "single" && ids.length !== 1) return fail(`"${q.header}" needs exactly one selection`);
    if (q.type === "rank") {
      if (ids.length !== options.length) return fail(`"${q.header}" needs every option ranked`);
    }
  }
  return { ok: true };
}

// --- model-facing result formatting ------------------------------------

function answerValueLine(q: StructuredQuestion, a: QuestionAnswer | undefined): string {
  if (!a) return `${q.header}: (no answer)`;
  if (a.youPick) return `${q.header}: you pick — choose your recommended option and say which`;
  if (a.other && a.other.trim()) return `${q.header}: "${a.other.trim()}"`;
  const options = q.options ?? [];
  const ids = a.selected ?? [];
  const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  if (q.type === "rank") return `${q.header}: ${ids.map((id, i) => `${i + 1}. ${label(id)}`).join(" ")}`;
  if (q.type === "multi") return `${q.header}: ${ids.map(label).join(", ")}`;
  return `${q.header}: "${ids[0] ? label(ids[0]) : "(no answer)"}"`;
}

/** The ask_owner tool's result for a structured, answered card: a
 *  readable line per question, then a compact JSON block the model can
 *  parse exactly. */
export function formatStructuredAnswers(
  questions: readonly StructuredQuestion[],
  answers: Record<string, QuestionAnswer>,
  owner: string,
): string {
  const lines = questions.map((q) => answerValueLine(q, answers[q.id]));
  const prose = questions.length === 1
    ? `${owner} answered — ${lines[0]}`
    : `${owner} answered:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  return `${prose}\n\n${JSON.stringify(answers)}`;
}

// --- composer typed-text mapping ----------------------------------------

/** Typing in the composer while a structured ask_owner card is pending
 *  (0081 decision 9): a lone `single` question maps the text to the
 *  matching option by 1-based number, letter (a/b/c…), or
 *  case-insensitive label; "you pick" selects You-pick; anything else is
 *  Other on that question. Every other shape (multi, rank, text, or more
 *  than one question) maps the text to Other on the FIRST question. */
export function mapTypedTextToAnswers(
  card: AskOwnerCard,
  text: string,
): Record<string, QuestionAnswer> | null {
  const questions = card.questions ?? [];
  const first = questions[0];
  if (!first) return null;
  const trimmed = text.trim();
  if (questions.length === 1 && first.type === "single") {
    if (/^you pick$/i.test(trimmed)) return { [first.id]: { youPick: true } };
    const options = first.options ?? [];
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
      return { [first.id]: { selected: [options[asNumber - 1]!.id] } };
    }
    if (/^[a-z]$/i.test(trimmed)) {
      const index = trimmed.toLowerCase().charCodeAt(0) - 97;
      if (index >= 0 && index < options.length) return { [first.id]: { selected: [options[index]!.id] } };
    }
    const byLabel = options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
    if (byLabel) return { [first.id]: { selected: [byLabel.id] } };
  }
  // No freeform slot: fall back to the legacy plain-text answer.
  if (!first.allowOther && first.type !== "text") return null;
  return { [first.id]: { other: text } };
}
