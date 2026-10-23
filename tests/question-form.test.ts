import { describe, expect, it } from "vitest";
import {
  formatStructuredAnswers,
  mapTypedTextToAnswers,
  resolveStructuredQuestions,
  validateAnswers,
  validateStructuredQuestions,
  type AskOwnerCard,
  type StructuredQuestion,
  type StructuredQuestionInput,
} from "../lib/question-form";

/**
 * 0081: the pure core behind structured ask_owner questions — no db, no
 * workflow run. Covers the business-rule validation a zod schema can't
 * express, screenshot-evidence resolution against a fake attach, the
 * server-side answer cross-check, the model-facing formatter (every
 * type, You pick, Other), and the composer's typed-text mapping.
 */

const singleQuestion = (overrides: Partial<StructuredQuestionInput> = {}): StructuredQuestionInput => ({
  id: "scope",
  header: "Scope",
  type: "single",
  options: [
    { id: "a", label: "Instructions block only" },
    { id: "b", label: "Instructions + validation" },
  ],
  ...overrides,
});

describe("validateStructuredQuestions", () => {
  it("accepts a well-formed single question", () => {
    expect(validateStructuredQuestions([singleQuestion()])).toEqual({ ok: true });
  });

  it("rejects an empty question list", () => {
    expect(validateStructuredQuestions([])).toMatchObject({ ok: false });
  });

  it("rejects more than 4 questions", () => {
    const qs = Array.from({ length: 5 }, (_, i) => singleQuestion({ id: `q${i}` }));
    expect(validateStructuredQuestions(qs).ok).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const result = validateStructuredQuestions([singleQuestion(), singleQuestion()]);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("duplicate question id") });
  });

  it("rejects options on a text question", () => {
    const q = singleQuestion({ type: "text", options: [{ id: "a", label: "A" }] });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false, message: expect.stringContaining("options are not allowed") });
  });

  it("allows a text question with no options", () => {
    const q: StructuredQuestionInput = { id: "name", header: "Name", type: "text" };
    expect(validateStructuredQuestions([q])).toEqual({ ok: true });
  });

  it("rejects too few options for a choice type", () => {
    const q = singleQuestion({ options: [{ id: "a", label: "Only one" }] });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false, message: expect.stringContaining("2-8 options") });
  });

  it("rejects too many options for a choice type", () => {
    const options = Array.from({ length: 9 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
    expect(validateStructuredQuestions([singleQuestion({ options })])).toMatchObject({ ok: false });
  });

  it("rejects duplicate option ids", () => {
    const q = singleQuestion({ options: [{ id: "a", label: "A" }, { id: "a", label: "B" }] });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false, message: expect.stringContaining("duplicate option id") });
  });

  it("rejects duplicate option labels (case-insensitive)", () => {
    const q = singleQuestion({ options: [{ id: "a", label: "Same" }, { id: "b", label: "same" }] });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false, message: expect.stringContaining("duplicate option label") });
  });

  it("rejects more than one recommended option on a single-type question", () => {
    const q = singleQuestion({
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: true },
      ],
    });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false, message: expect.stringContaining("at most one option may be recommended") });
  });

  it("allows more than one recommended option on a multi-type question", () => {
    const q = singleQuestion({
      type: "multi",
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: true },
      ],
    });
    expect(validateStructuredQuestions([q])).toEqual({ ok: true });
  });

  it("rank needs at least 2 options, same as any other choice type", () => {
    const q = singleQuestion({ type: "rank", options: [{ id: "a", label: "A" }] });
    expect(validateStructuredQuestions([q])).toMatchObject({ ok: false });
  });
});

describe("resolveStructuredQuestions", () => {
  it("resolves a successful screenshot attach to an attachment id/url", async () => {
    const q = singleQuestion({
      options: [
        { id: "a", label: "A", evidence: { type: "screenshot", path: "/work/shot.png", label: "before" } },
        { id: "b", label: "B" },
      ],
    });
    const resolved = await resolveStructuredQuestions([q], async () => ({ ok: true, id: "att_123", url: "/api/attachments/att_123" }));
    expect(resolved[0]!.options![0]!.evidence).toEqual({ type: "screenshot", attachmentId: "att_123", url: "/api/attachments/att_123" });
    expect(resolved[0]!.options![1]!.evidence).toBeUndefined();
  });

  it("marks a failed screenshot attach unavailable instead of failing the whole ask", async () => {
    const q = singleQuestion({
      options: [
        { id: "a", label: "A", evidence: { type: "screenshot", path: "/no/such/file.png" } },
        { id: "b", label: "B" },
      ],
    });
    const resolved = await resolveStructuredQuestions([q], async () => ({ ok: false }));
    expect(resolved[0]!.options![0]!.evidence).toEqual({ type: "screenshot", unavailable: true });
  });

  it("passes non-screenshot evidence straight through", async () => {
    const q = singleQuestion({
      options: [
        { id: "a", label: "A", evidence: { type: "code", lang: "ts", text: "const x = 1;" } },
        { id: "b", label: "B", evidence: { type: "diff", text: "+added\n-removed" } },
      ],
    });
    const resolved = await resolveStructuredQuestions([q], async () => ({ ok: true }));
    expect(resolved[0]!.options![0]!.evidence).toEqual({ type: "code", lang: "ts", text: "const x = 1;" });
    expect(resolved[0]!.options![1]!.evidence).toEqual({ type: "diff", text: "+added\n-removed" });
  });

  it("resolves allowOther's default and a text question's lack of options", async () => {
    const resolved = await resolveStructuredQuestions(
      [singleQuestion(), { id: "name", header: "Name", type: "text" }],
      async () => ({ ok: true }),
    );
    expect(resolved[0]!.allowOther).toBe(true);
    expect(resolved[1]).toEqual({ id: "name", header: "Name", type: "text", allowOther: true });
  });

  it("honors an explicit allowOther: false", async () => {
    const resolved = await resolveStructuredQuestions([singleQuestion({ allowOther: false })], async () => ({ ok: true }));
    expect(resolved[0]!.allowOther).toBe(false);
  });
});

const resolvedSingle: StructuredQuestion = {
  id: "scope",
  header: "Scope",
  type: "single",
  allowOther: true,
  options: [
    { id: "a", label: "Instructions block only" },
    { id: "b", label: "Instructions + validation" },
  ],
};

const resolvedMulti: StructuredQuestion = {
  id: "areas",
  header: "Areas",
  type: "multi",
  allowOther: true,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
};

const resolvedRank: StructuredQuestion = {
  id: "priority",
  header: "Priority",
  type: "rank",
  allowOther: true,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
};

const resolvedText: StructuredQuestion = { id: "name", header: "Name", type: "text", allowOther: true };

function cardOf(...questions: StructuredQuestion[]): AskOwnerCard {
  return { kind: "ask_owner", questions };
}

describe("validateAnswers", () => {
  it("accepts a valid single selection", () => {
    expect(validateAnswers(cardOf(resolvedSingle), { scope: { selected: ["a"] } })).toEqual({ ok: true });
  });

  it("accepts You pick", () => {
    expect(validateAnswers(cardOf(resolvedSingle), { scope: { youPick: true } })).toEqual({ ok: true });
  });

  it("accepts Other", () => {
    expect(validateAnswers(cardOf(resolvedSingle), { scope: { other: "Something else" } })).toEqual({ ok: true });
  });

  it("rejects an unknown question id", () => {
    const result = validateAnswers(cardOf(resolvedSingle), { bogus: { selected: ["a"] } });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('unknown question "bogus"') });
  });

  it("rejects an unknown option id", () => {
    const result = validateAnswers(cardOf(resolvedSingle), { scope: { selected: ["zzz"] } });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("unknown option") });
  });

  it("rejects a missing answer for a question", () => {
    expect(validateAnswers(cardOf(resolvedSingle, resolvedText), { scope: { selected: ["a"] } })).toMatchObject({ ok: false });
  });

  it("rejects answering more than one way", () => {
    const result = validateAnswers(cardOf(resolvedSingle), { scope: { selected: ["a"], youPick: true } });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("more than one way") });
  });

  it("rejects more than one selection on a single-type question", () => {
    expect(validateAnswers(cardOf(resolvedSingle), { scope: { selected: ["a", "b"] } })).toMatchObject({ ok: false });
  });

  it("accepts any non-empty subset on a multi-type question", () => {
    expect(validateAnswers(cardOf(resolvedMulti), { areas: { selected: ["a", "c"] } })).toEqual({ ok: true });
  });

  it("rank requires every option ranked exactly once", () => {
    expect(validateAnswers(cardOf(resolvedRank), { priority: { selected: ["a", "b"] } })).toMatchObject({ ok: false });
    expect(validateAnswers(cardOf(resolvedRank), { priority: { selected: ["a", "a", "b"] } })).toMatchObject({ ok: false });
    expect(validateAnswers(cardOf(resolvedRank), { priority: { selected: ["c", "a", "b"] } })).toEqual({ ok: true });
  });

  it("rejects a selection on a text question", () => {
    expect(validateAnswers(cardOf(resolvedText), { name: { selected: ["a"] } })).toMatchObject({ ok: false });
  });

  it("rejects when the card has no structured questions", () => {
    expect(validateAnswers({ kind: "ask_owner" }, {})).toMatchObject({ ok: false });
  });
});

describe("formatStructuredAnswers", () => {
  it("formats a single-question single answer as a quoted label with an em dash", () => {
    const text = formatStructuredAnswers([resolvedSingle], { scope: { selected: ["a"] } }, "Chad");
    expect(text).toContain('Chad answered — Scope: "Instructions block only"');
    expect(text).toContain('{"scope":{"selected":["a"]}}');
  });

  it("formats You pick", () => {
    const text = formatStructuredAnswers([resolvedSingle], { scope: { youPick: true } }, "Chad");
    expect(text).toContain("Scope: you pick — choose your recommended option and say which");
  });

  it("formats Other with the typed text quoted", () => {
    const text = formatStructuredAnswers([resolvedSingle], { scope: { other: "Neither, do X" } }, "Chad");
    expect(text).toContain('Scope: "Neither, do X"');
  });

  it("formats a rank answer as a numbered order", () => {
    const text = formatStructuredAnswers([resolvedRank], { priority: { selected: ["c", "a", "b"] } }, "Chad");
    expect(text).toContain("Priority: 1. C 2. A 3. B");
  });

  it("formats a multi answer as a comma list", () => {
    const text = formatStructuredAnswers([resolvedMulti], { areas: { selected: ["a", "c"] } }, "Chad");
    expect(text).toContain("Areas: A, C");
  });

  it("formats multiple questions as a bulleted list", () => {
    const text = formatStructuredAnswers(
      [resolvedSingle, resolvedText],
      { scope: { selected: ["a"] }, name: { other: "widget" } },
      "Chad",
    );
    expect(text).toContain("Chad answered:\n- Scope:");
    expect(text).toContain('- Name: "widget"');
  });
});

describe("mapTypedTextToAnswers", () => {
  const card = cardOf(resolvedSingle);

  it("maps a 1-based number to the matching option", () => {
    expect(mapTypedTextToAnswers(card, "2")).toEqual({ scope: { selected: ["b"] } });
  });

  it("maps a letter to the matching option", () => {
    expect(mapTypedTextToAnswers(card, "a")).toEqual({ scope: { selected: ["a"] } });
    expect(mapTypedTextToAnswers(card, "B")).toEqual({ scope: { selected: ["b"] } });
  });

  it("maps a case-insensitive label match", () => {
    expect(mapTypedTextToAnswers(card, "instructions block only")).toEqual({ scope: { selected: ["a"] } });
  });

  it('maps "you pick" (any case) to You pick', () => {
    expect(mapTypedTextToAnswers(card, "You Pick")).toEqual({ scope: { youPick: true } });
  });

  it("falls back to Other for anything else", () => {
    expect(mapTypedTextToAnswers(card, "do whatever you think is best")).toEqual({
      scope: { other: "do whatever you think is best" },
    });
  });

  it("maps to Other on the first question for a multi-question card", () => {
    const multiQ = cardOf(resolvedSingle, resolvedText);
    expect(mapTypedTextToAnswers(multiQ, "2")).toEqual({ scope: { other: "2" } });
  });

  it("maps to Other on the first question for a non-single choice type", () => {
    expect(mapTypedTextToAnswers(cardOf(resolvedRank), "whatever")).toEqual({ priority: { other: "whatever" } });
  });

  it("returns null for a card with no questions", () => {
    expect(mapTypedTextToAnswers({ kind: "ask_owner" }, "hi")).toBeNull();
  });
});
