import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { start } from "workflow/api";
import { db } from "../db";
import { ensureConversation, listMessageTexts, listModelMessages, listTurnMessages } from "../db/chat";
import { __setGatewayForTests } from "../lib/skills/store";
import { chatTurn } from "../workflows/chat/turn";
import { loadAttachedSkillsStep, loadSkillsCatalogStep } from "../workflows/chat/steps/skills";
import { recordUserMessage } from "../workflows/chat/steps/turn";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0091 §3: attached skills through the turn's own pieces.
 *
 * The wiring test runs the real steps in-process (the fake bucket
 * injects into lib/skills/store's module state — the workflow executor
 * builds its own bundle and cannot see it, the x-chat "skill" test's
 * known limitation), composing exactly what turn.ts composes: the
 * attach step's note, recordUserMessage's metadata stamping, and
 * listTurnMessages' replay. The executor test then proves the
 * end-to-end guarantee the bundle CAN see: a send with attached skills
 * against an unconfigured store drops them silently, never breaking the
 * turn (the "attach" mock script counts `# Attached skills` sections).
 */

let executor: WorkflowExecutor | null = null;

beforeAll(async () => {
  executor = await startWorkflowExecutor();
}, 120_000);

afterAll(async () => {
  await executor?.close();
});

let bucket: FakeBucket;

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
});

describe("0091 §3: the turn's attached-skills wiring (in-process)", () => {
  it("stamps the ids and note on the user row and replays it before that row", async () => {
    bucket.seed("pdf", skillMd("Make PDFs", "# PDF runbook.\n\nRender it."));
    const id = `c_test_attw_${Math.random().toString(36).slice(2, 8)}`;
    ensureConversation(db(), id);

    // Exactly turn.ts's composition, with one attached id and one unknown.
    const attached = await loadAttachedSkillsStep(["pdf", "nope"]);
    expect(attached.attached).toEqual(["pdf"]);
    await recordUserMessage(id, "make me a pdf", 0, undefined, undefined, undefined, undefined, attached.attached, attached.note ?? undefined);

    // The row's metadata carries the ids (chips) and the rendered note…
    const userRow = listMessageTexts(db(), id).find((r) => r.role === "user");
    expect(userRow?.metadata?.attachedSkills).toEqual(["pdf"]);
    expect(userRow?.metadata?.attachedSkillsNote).toContain("## pdf");
    expect(userRow?.metadata?.attachedSkillsNote).toContain("# PDF runbook.");

    // …and listTurnMessages replays the note verbatim, right before the row.
    const messages = listTurnMessages(db(), id);
    expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
    expect(messages[0]).toEqual({ role: "user", content: attached.note });
    expect(userRow?.metadata?.attachedSkillsNote).not.toContain("nope");

    // The appendix for THIS turn excludes the attached id; a plain turn
    // (no exclusions) lists it again.
    expect((await loadSkillsCatalogStep(attached.attached)).map((s) => s.id)).toEqual([]);
    expect((await loadSkillsCatalogStep()).map((s) => s.id)).toEqual(["pdf"]);
  });
});

describe("0091 §3: attached skills end-to-end (executor bundle)", () => {
  beforeEach(() => {
    process.env.SWEATSHOP_CHAT_MOCK = "attach";
    __setGatewayForTests(null);
    for (const key of Object.keys(process.env)) if (key.startsWith("SKILLS_S3_")) delete process.env[key];
  });

  it(
    "a send with attached skills against an unconfigured store drops them silently",
    { timeout: 30_000 },
    async () => {
      const id = `c_test_atte_${Math.random().toString(36).slice(2, 8)}`;
      ensureConversation(db(), id);
      const run = await start(chatTurn, [
        { conversationId: id, userText: "make me a pdf", attachedSkills: ["pdf"] },
      ]);
      await run.returnValue;

      // No `# Attached skills` section reached the model, no appendix
      // exists — and the turn itself completed with normal rows.
      const rows = listModelMessages(db(), id);
      expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(rows[1])).toContain("mock-attach:0:omitted");
      const userRow = listMessageTexts(db(), id).find((r) => r.role === "user");
      expect(userRow?.metadata?.attachedSkills).toBeUndefined();
      expect(userRow?.metadata?.attachedSkillsNote).toBeUndefined();
    },
  );
});
