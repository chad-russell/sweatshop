import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { appendNewer, backgroundChildIds, replaceLiveTurn, hasBackgroundChild, liveBackgroundChildIds, liveTurnChanged, mergeOlder, rowsToUIMessages, untilLiveTurn, type StoredRow } from "../lib/chat-ui";
import { parseViewingContext, viewingNote } from "../lib/page-context";

let n = 0;
const row = (modelMessage: ModelMessage): StoredRow => {
  n += 1;
  return { id: `m${n}`, role: modelMessage.role, text: "flat", at: 1000 + n, modelMessage };
};

describe("rowsToUIMessages", () => {
  it("folds assistant/tool/assistant rows into one message with settled tool parts", () => {
    const ui = rowsToUIMessages([
      row({ role: "user", content: "run pi" }),
      row({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "pi", input: { task: "ls" } }],
      }),
      row({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "pi",
            output: { type: "error-text", value: "boom" },
          },
        ],
      }),
      row({
        role: "assistant",
        content: [
          { type: "text", text: "failed" },
          { type: "tool-call", toolCallId: "c2", toolName: "bash", input: { command: "ls" } },
        ],
      }),
      row({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "bash",
            output: { type: "json", value: { stdout: "a" } },
          },
        ],
      }),
      row({ role: "assistant", content: [{ type: "text", text: "done" }] }),
    ]);

    expect(ui.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ui[1].parts).toMatchObject([
      { type: "tool-pi", state: "output-error", errorText: "boom", input: { task: "ls" } },
      { type: "text", text: "failed" },
      { type: "tool-bash", state: "output-available", output: { stdout: "a" } },
      { type: "text", text: "done" },
    ]);
  });

  it("starts a new assistant message after each user message", () => {
    const ui = rowsToUIMessages([
      row({ role: "user", content: "a" }),
      row({ role: "assistant", content: "b" }),
      row({ role: "user", content: "c" }),
      row({ role: "assistant", content: "d" }),
    ]);
    expect(ui.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("keeps text-only legacy rows without a model message", () => {
    const ui = rowsToUIMessages([
      { id: "x", role: "assistant", text: "old", at: 1, modelMessage: null },
    ]);
    expect(ui[0].parts).toEqual([{ type: "text", text: "old" }]);
  });

  it("carries a user row's viewing context as message metadata (0015)", () => {
    const ui = rowsToUIMessages([
      { id: "v1", role: "user", text: "this?", at: 1, modelMessage: { role: "user", content: "this?" }, metadata: { viewing: { kind: "machine", id: "ticket", selection: "stage verify" } } },
      { id: "v2", role: "assistant", text: "ok", at: 2, modelMessage: { role: "assistant", content: "ok" } },
      { id: "v3", role: "user", text: "plain", at: 3, modelMessage: { role: "user", content: "plain" } },
    ]);
    expect(ui[0].metadata).toMatchObject({ viewing: { kind: "machine", id: "ticket" } });
    expect(ui[2].metadata).not.toHaveProperty("viewing");
  });

  it("carries a wake row's runEvent so it renders as a chip, not Chad's words (0022)", () => {
    const runEvent = { kind: "harness" as const, id: "hc_1", status: "completed" };
    const ui = rowsToUIMessages([
      { id: "w1", role: "user", text: "[pi finished] — /h/pi/c", at: 1, modelMessage: { role: "user", content: "[pi finished] — /h/pi/c" }, metadata: { runEvent } },
    ]);
    expect(ui[0].metadata).toMatchObject({ runEvent });
  });
});

describe("viewing note (0015)", () => {

  it("names what Chad is viewing, the details, and the fetch tool", () => {
    const note = viewingNote({
      kind: "machine",
      id: "ticket",
      title: "Ticket",
      selection: "stage verify",
      path: "/machines/ticket",
    });
    expect(note.startsWith("[viewing] Chad is viewing machine \"Ticket\" (`ticket`)")).toBe(true);
    expect(note).toContain("at /machines/ticket");
    expect(note).toContain("selected: stage verify");
    expect(note).toContain("get_machine");
  });

  it("accepts only the known shape", () => {
    expect(parseViewingContext({ kind: "chat", id: "c_1" })).toEqual({ kind: "chat", id: "c_1" });
    expect(parseViewingContext({ kind: "nope" })).toBeNull();
    expect(parseViewingContext({ kind: "chat", extra: true })).toBeNull();
    expect(parseViewingContext(null)).toBeNull();
  });
});

describe("hasBackgroundChild (0022 wake watch)", () => {
  const started = (tool: string, output: unknown): import("ai").UIMessage => ({
    id: `a_${tool}`,
    role: "assistant",
    parts: [{ type: `tool-${tool}`, toolCallId: "t", state: "output-available", input: {}, output } as never],
  });
  const wake: import("ai").UIMessage = { id: "w", role: "user", parts: [{ type: "text", text: "[pi finished]" }], metadata: { runEvent: { kind: "harness", id: "hc_1", status: "completed" } } };

  it("is true while a started run or harness call has not woken the chat yet", () => {
    expect(hasBackgroundChild([started("pi", { ok: true, callId: "hc_1" })])).toBe(true);
    expect(hasBackgroundChild([started("start_machine", { runId: "mr_1", url: "/r/mr_1" })])).toBe(true);
  });
  it("is false with nothing started, a listing, a failed start, or after the wake", () => {
    expect(hasBackgroundChild([])).toBe(false);
    expect(hasBackgroundChild([started("start_machine", { machines: [] })])).toBe(false);
    expect(hasBackgroundChild([started("pi", { ok: false, code: "busy" })])).toBe(false);
    expect(hasBackgroundChild([started("pi", { ok: true, callId: "hc_1" }), wake])).toBe(false);
  });
});

describe("backgroundChildIds (0055 PR2: Mode chip's Working now set)", () => {
  const started = (tool: string, output: unknown): import("ai").UIMessage => ({
    id: `a_${tool}_${JSON.stringify(output)}`,
    role: "assistant",
    parts: [{ type: `tool-${tool}`, toolCallId: "t", state: "output-available", input: {}, output } as never],
  });

  it("collects harness callIds and start_thread ids, in first-seen order, deduped", () => {
    const ids = backgroundChildIds([
      started("pi", { ok: true, callId: "hc_1" }),
      started("start_thread", { ok: true, id: "c_1" }),
      started("claude", { ok: true, callId: "hc_2" }),
      started("pi", { ok: true, callId: "hc_1" }), // a later pi call that reuses... never happens, but dedup is cheap insurance
    ]);
    expect(ids).toEqual(["hc_1", "c_1", "hc_2"]);
  });

  it("ignores failed starts, in-flight calls, and non-harness tools", () => {
    const ids = backgroundChildIds([
      started("pi", { ok: false, code: "busy" }),
      started("bash", { ok: true, stdout: "hi" }),
      { id: "x", role: "assistant", parts: [{ type: "tool-pi", toolCallId: "t", state: "input-streaming", input: {} } as never] },
    ]);
    expect(ids).toEqual([]);
  });

  it("is empty for an empty transcript", () => {
    expect(backgroundChildIds([])).toEqual([]);
  });
});

describe("liveBackgroundChildIds (0055 PR2 review fix: stop polling settled children)", () => {
  const started = (tool: string, output: unknown): import("ai").UIMessage => ({
    id: `a_${tool}_${JSON.stringify(output)}`,
    role: "assistant",
    parts: [{ type: `tool-${tool}`, toolCallId: "t", state: "output-available", input: {}, output } as never],
  });
  const wake = (kind: string, id: string): import("ai").UIMessage => ({
    id: `w_${kind}_${id}`,
    role: "user",
    parts: [{ type: "text", text: `[${kind} finished]` }],
    metadata: { runEvent: { kind, id, status: "completed" } },
  });

  it("excludes a child whose wake row already arrived", () => {
    const ids = liveBackgroundChildIds([
      started("pi", { ok: true, callId: "hc_1" }),
      wake("harness", "hc_1"),
    ]);
    expect(ids).toEqual([]);
  });

  it("keeps a child with no wake row yet, alongside one that already woke", () => {
    const ids = liveBackgroundChildIds([
      started("pi", { ok: true, callId: "hc_1" }),
      wake("harness", "hc_1"),
      started("start_thread", { ok: true, id: "c_1" }),
    ]);
    expect(ids).toEqual(["c_1"]);
  });

  it("a thread child's wake is kind \"thread\", by conversation id", () => {
    const ids = liveBackgroundChildIds([
      started("start_thread", { ok: true, id: "c_1" }),
      wake("thread", "c_1"),
    ]);
    expect(ids).toEqual([]);
  });

  it("ignores other runEvent kinds (budget/plan/mode) — they never name a background child", () => {
    const ids = liveBackgroundChildIds([
      started("pi", { ok: true, callId: "hc_1" }),
      wake("budget", "hc_1"),
    ]);
    expect(ids).toEqual(["hc_1"]);
  });

  it("is empty for an empty transcript", () => {
    expect(liveBackgroundChildIds([])).toEqual([]);
  });
});

describe("untilLiveTurn (0037 incremental persistence)", () => {
  const row = (id: string, role: string): StoredRow => ({ id, role, text: "", at: 0, modelMessage: null });
  it("cuts after the live turn's opening row, dropping its persisted slices", () => {
    const rows = [
      row("t_c_0", "user"),
      row("m_c_1_0", "assistant"),
      row("t_c_2", "user"),
      row("sq_c_1", "user"),
      row("m_c_3_0", "assistant"),
      row("m_c_3_1", "tool"),
    ];
    expect(untilLiveTurn(rows).map((r) => r.id)).toEqual(["t_c_0", "m_c_1_0", "t_c_2"]);
    expect(untilLiveTurn([row("x", "user")])).toHaveLength(1);
  });
});

// ── 0075 lazy transcript window merges ────────────────────────────────

let k = 0;
const msg = (id: string, role: "user" | "assistant" = "assistant"): UIMessage => {
  k += 1;
  return { id, role, parts: [{ type: "text", text: `body ${k}` }] };
};

describe("mergeOlder (load-earlier pages prepend, never duplicate)", () => {
  it("prepends unknown older messages and keeps the window intact", () => {
    const window = [msg("m3"), msg("m4")];
    const older = [msg("m1"), msg("m2")];
    expect(mergeOlder(window, older).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("drops older messages the window already shows (overlap pages)", () => {
    const window = [msg("m3"), msg("m4")];
    const older = [msg("m2"), msg("m3")]; // partial overlap at the seam
    expect(mergeOlder(window, older).map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
  });

  it("never mutates its inputs and tolerates an empty page", () => {
    const window = [msg("m1")];
    const older: UIMessage[] = [];
    expect(mergeOlder(window, older)).toEqual(window);
    expect(mergeOlder(window, older)).not.toBe(window); // a fresh array
    const before = window.length;
    mergeOlder(window, [msg("m0")]);
    expect(window.length).toBe(before);
  });
});

describe("appendNewer (wake poll tail pages append, gated at turn boundaries)", () => {
  it("aligned page: appends only unknown messages", () => {
    const window = [msg("m1"), msg("m2")];
    const page = [msg("m2"), msg("m3"), msg("m4")];
    expect(appendNewer(window, page).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("misaligned page: appends from the first unseen t_ turn opener", () => {
    const window = [msg("t_c1_1"), msg("m2")];
    // A tail page that starts mid-fold (m1) and contains the wake turn.
    const page = [msg("m1"), msg("t_c1_2"), msg("m5")];
    expect(appendNewer(window, page).map((m) => m.id)).toEqual(["t_c1_1", "m2", "t_c1_2", "m5"]);
  });

  it("misaligned page with no unseen turn opener changes nothing (partial folds never append)", () => {
    const window = [msg("t_c1_1"), msg("m2")];
    const page = [msg("m0"), msg("m2")]; // overlap, but the seam is mid-fold
    expect(appendNewer(window, page).map((m) => m.id)).toEqual(["t_c1_1", "m2"]);
  });

  it("an empty page or empty window are no-ops / straight appends", () => {
    const window = [msg("m1")];
    expect(appendNewer(window, [])).toEqual(window);
    const page = [msg("t_c1_1")];
    expect(appendNewer([], page).map((m) => m.id)).toEqual(["t_c1_1"]);
  });
});

// ── 0076: replaceLiveTurn + span-safe appendNewer (review findings 1-2) ──

describe("replaceLiveTurn", () => {
  const openerRow = (id: string, text: string): StoredRow => ({
    id,
    role: "user",
    text,
    at: 1000,
    modelMessage: { role: "user", content: text },
  });
  const sliceRow = (id: string, text: string): StoredRow => ({
    id,
    role: "assistant",
    text,
    at: 1001,
    modelMessage: { role: "assistant", content: [{ type: "text", text }] },
  });
  const textsOf = (msgs: ReturnType<typeof rowsToUIMessages>) =>
    msgs.flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));

  it("replaces a growing live turn's fold (stable fold id, fuller parts) without duplicating slices", () => {
    const poll1 = rowsToUIMessages([openerRow("t_1", "go"), sliceRow("m_skip0_1", "slice one")]);
    const poll2 = rowsToUIMessages([
      openerRow("t_1", "go"),
      sliceRow("m_skip0_1", "slice one"),
      sliceRow("m_skip0_2", "slice two"),
    ]);
    expect(poll1.map((m) => m.id)).toEqual(["t_1", "m_skip0_1"]);
    expect(poll2.map((m) => m.id)).toEqual(["t_1", "m_skip0_1"]); // stable id…
    expect(textsOf(poll2)).toEqual(["go", "slice one", "slice two"]); // …fuller fold
    const merged = replaceLiveTurn(poll1, poll2);
    expect(textsOf(merged).filter((t) => t === "slice one")).toHaveLength(1);
    expect(textsOf(merged).filter((t) => t === "slice two")).toHaveLength(1);
  });

  it("keeps settled history before the opener and replaces only the live fold", () => {
    const settled = rowsToUIMessages([
      openerRow("t_0", "first"),
      sliceRow("m_a", "done"),
      openerRow("t_1", "second"),
      sliceRow("m_b", "live"),
    ]);
    const grown = rowsToUIMessages([
      openerRow("t_1", "second"),
      sliceRow("m_b", "live"),
      sliceRow("m_c", "more"),
    ]);
    const merged = replaceLiveTurn(settled, grown);
    expect(merged.map((m) => m.id)).toEqual(["t_0", "m_a", "t_1", "m_b"]);
    expect(textsOf(merged)).toEqual(["first", "done", "second", "live", "more"]);
  });

  it("finding 1: a page spanning BELOW the window never re-appends window content between opener and live fold", () => {
    const windowMsgs = rowsToUIMessages([
      openerRow("t_1", "w1"),
      sliceRow("m_w1", "w1 body"),
      openerRow("t_2", "w2"),
      sliceRow("m_w2", "w2 live"),
    ]);
    const spanning = rowsToUIMessages([
      openerRow("t_0", "below"),
      sliceRow("m_b0", "below body"),
      openerRow("t_1", "w1"),
      sliceRow("m_w1", "w1 body"),
      openerRow("t_2", "w2"),
      sliceRow("m_w2", "w2 live"),
      sliceRow("m_w3", "w3 new"),
    ]);
    const merged = replaceLiveTurn(windowMsgs, spanning);
    // m_w3 is a later row of the live turn — it folds INTO the m_w2
    // message (parts grow), it is not a message of its own.
    expect(merged.map((m) => m.id)).toEqual(["t_1", "m_w1", "t_2", "m_w2"]);
    expect(textsOf(merged)).toEqual(["w1", "w1 body", "w2", "w2 live", "w3 new"]);
  });

  it("finding 2: a no-opener window live-updates by replacing its last fold (never freezes)", () => {
    const windowMsgs = rowsToUIMessages([sliceRow("m_9_0_0", "s1 s2")]);
    const page = rowsToUIMessages([sliceRow("m_9_0_0", "s1 s2 s3")]);
    expect(page.map((m) => m.id)).toEqual(["m_9_0_0"]);
    const merged = replaceLiveTurn(windowMsgs, page);
    expect(textsOf(merged)).toEqual(["s1 s2 s3"]); // growth LANDED
    // A page that does not cover the window's tail is a no-op (waits).
    const narrow = rowsToUIMessages([sliceRow("m_other", "x")]);
    expect(replaceLiveTurn(merged, narrow).map((m) => m.id)).toEqual(["m_9_0_0"]);
  });
});

describe("appendNewer (span-safe)", () => {
  const msg = (id: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: id }] });

  it("finding 1: a wake page spanning below the window appends only rows after the window's last known row", () => {
    const windowMsgs = [msg("t_1"), msg("m_1"), msg("t_2"), msg("m_2")];
    const spanning = [msg("t_0"), msg("m_0"), msg("t_1"), msg("m_1"), msg("t_2"), msg("m_2"), msg("t_3"), msg("m_3")];
    const merged = appendNewer(windowMsgs, spanning);
    expect(merged.map((m) => m.id)).toEqual(["t_1", "m_1", "t_2", "m_2", "t_3", "m_3"]);
  });

  it("finding 1: fresh ids only BELOW the window head are older rows — an entirely-below page is not a poll shape; overlap is the guard", () => {
    // Polls fetch the newest tail: a page of ONLY older rows than the
    // window cannot occur while the window is current (it would mean
    // the window shows rows newer than the store's newest). The unsafe
    // shape is OVERLAP + fresh-below — covered above. This documents
    // the disjoint-older case: unseen t_ rows WOULD append (a wake
    // turn the window never saw, in a page disjoint by ids) — same
    // branch as the legacy test "misaligned page appends from the
    // first unseen t_".
    const windowMsgs = [msg("m_2")]; // mid-fold head, no t_ in window
    const disjointNewTurn = [msg("m_9"), msg("t_9"), msg("m_99")];
    expect(appendNewer(windowMsgs, disjointNewTurn).map((m) => m.id)).toEqual([
      "m_2",
      "t_9",
      "m_99",
    ]);
  });

  it("exact-alignment fast path and no-overlap turn gate still hold", () => {
    expect(appendNewer([msg("m1")], [msg("m1"), msg("m2")]).map((m) => m.id)).toEqual(["m1", "m2"]);
    const midFold = [msg("mX")]; // no t_ anywhere
    expect(appendNewer(midFold, [msg("mY")]).map((m) => m.id)).toEqual(["mX"]);
  });
});

// ── 0076 followup to #19/#20: live folds froze in watching tabs ──

describe("liveTurnChanged", () => {
  const msg = (id: string, ...texts: string[]): UIMessage => ({
    id,
    role: "assistant",
    parts: texts.map((text) => ({ type: "text" as const, text })),
  });

  it("is true when a KNOWN fold id grew parts (the freeze regression)", () => {
    const windowMsgs = [msg("t_1", "go"), msg("m_a", "one")];
    expect(liveTurnChanged(windowMsgs, [msg("t_1", "go"), msg("m_a", "one", "two")])).toBe(true);
  });

  it("is true when a known part's text grew", () => {
    expect(liveTurnChanged([msg("m_a", "on")], [msg("m_a", "one")])).toBe(true);
  });

  it("is false for identical copies", () => {
    const windowMsgs = [msg("t_1", "go"), msg("m_a", "one")];
    expect(liveTurnChanged(windowMsgs, [msg("t_1", "go"), msg("m_a", "one")])).toBe(false);
  });

  it("is true for a new id", () => {
    expect(liveTurnChanged([msg("m_a", "one")], [msg("m_a", "one"), msg("m_b", "x")])).toBe(true);
  });
});

describe("replaceLiveTurn: grown fold + new message", () => {
  it("keeps the opener, replaces the fold with its fuller copy, appends the new message once", () => {
    const opener: UIMessage = { id: "t_1", role: "user", parts: [{ type: "text", text: "go" }] };
    const fold1: UIMessage = { id: "m_a", role: "assistant", parts: [{ type: "text", text: "one" }] };
    const fold2: UIMessage = { ...fold1, parts: [...fold1.parts, { type: "text", text: "two" }] };
    const toolMsg = {
      id: "m_b",
      role: "assistant",
      parts: [{ type: "tool-bash", toolCallId: "c1", state: "input-available", input: {} }],
    } as unknown as UIMessage;
    const merged = replaceLiveTurn([opener, fold1], [opener, fold2, toolMsg]);
    expect(merged.map((m) => m.id)).toEqual(["t_1", "m_a", "m_b"]);
    expect(merged[1]!.parts).toHaveLength(2);
  });
});
