import { describe, expect, it } from "vitest";
import { db } from "../db";
import { loadPendingRequests } from "../db/attention";
import { ensureConversation, recordPendingInput, resolvePendingInput } from "../db/chat";
import { publishEdit } from "../db/prompt-settings";
import {
  applyApprovedPromptChangeStep,
  promptChangePreviewStep,
} from "../workflows/chat/steps/prompt-change";

let seq = 0;
const skillId = () => `proposal-test-${++seq}`;

describe("0054 agent prompt proposals", () => {
  it("rejects invalid shapes before producing a proposal card", async () => {
    await expect(promptChangePreviewStep({
      kind: "section",
      key: "base",
      status: "deleted",
      note: "invalid section metadata",
    })).resolves.toMatchObject({ ok: false, code: "invalid" });

    await expect(promptChangePreviewStep({
      kind: "skill",
      key: skillId(),
      description: "no body on creation",
      note: "invalid creation",
    })).resolves.toMatchObject({ ok: false, code: "invalid" });
  });

  it("snapshots the complete body diff and exact skill metadata for review", async () => {
    const id = skillId();
    const body = `# Proposed\n\n${"full review text\n".repeat(200)}`;
    const preview = await promptChangePreviewStep({
      kind: "skill",
      key: id,
      body,
      description: "proposal fixture",
      thread: true,
      status: "active",
      note: "create the fixture skill",
    });
    expect(preview).toMatchObject({
      ok: true,
      expectedVersion: 0,
      card: {
        kind: "prompt_change",
        currentVersion: 0,
        patch: { body, description: "proposal fixture", thread: true, status: "active" },
      },
    });
    if (!preview.ok) throw new Error("expected valid preview");
    expect(preview.card.diff?.filter((line) => line.op === "add").map((line) => line.text).join("\n"))
      .toContain("full review text");

    const conversationId = `c_prompt_proposal_${seq}`;
    ensureConversation(db(), conversationId);
    recordPendingInput(db(), {
      id: `prompt_call_${seq}`,
      conversationId,
      kind: "approval",
      question: preview.summary,
      card: preview.card,
    });
    const request = loadPendingRequests(db()).get(conversationId)?.[0];
    expect(request?.toolName).toBe("propose_prompt_change");
    expect(request?.evidence).toBeNull();
    expect(request?.promptChange?.patch.body).toBe(body);
    resolvePendingInput(db(), `prompt_call_${seq}`, { approved: false });
  });

  it("applies once after approval and conflicts after a concurrent user edit", async () => {
    const id = skillId();
    const preview = await promptChangePreviewStep({
      kind: "skill", key: id, body: "# Initial", note: "create it",
    });
    if (!preview.ok) throw new Error("expected valid preview");
    expect(await applyApprovedPromptChangeStep(
      preview.target, preview.patch, preview.expectedVersion, "create it",
    )).toMatchObject({ ok: true, version: 1 });

    const stale = await promptChangePreviewStep({
      kind: "skill", key: id, status: "disabled", note: "retire it",
    });
    if (!stale.ok) throw new Error("expected valid preview");
    expect(publishEdit(db(), stale.target, {
      patch: { description: "user won the race" },
      expectedVersion: stale.expectedVersion,
    })).toMatchObject({ ok: true, version: 2 });
    expect(await applyApprovedPromptChangeStep(
      stale.target, stale.patch, stale.expectedVersion, "retire it",
    )).toMatchObject({ ok: false, code: "conflict" });
  });
});
