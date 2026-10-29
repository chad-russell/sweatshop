import { describe, expect, it } from "vitest";
import { db } from "../db";
import { loadPendingRequests } from "../db/attention";
import { ensureConversation, recordPendingInput, resolvePendingInput } from "../db/chat";
import { getTarget, publishEdit } from "../db/prompt-settings";
import {
  applyApprovedPromptChangeStep,
  promptChangePreviewStep,
} from "../workflows/chat/steps/prompt-change";

/** 0054 agent prompt proposals — sections only since 0088 (skills use save_skill). */

describe("0054 agent prompt proposals", () => {
  it("rejects invalid shapes before producing a proposal card", async () => {
    await expect(promptChangePreviewStep({ key: "nope", body: "x", note: "unknown section" })).resolves.toMatchObject({
      ok: false,
      code: "not-found",
    });
    await expect(
      promptChangePreviewStep({ key: "base", body: "x".repeat(32 * 1024 + 1), note: "too big" }),
    ).resolves.toMatchObject({ ok: false, code: "invalid" });
  });

  it("snapshots the complete body diff for review", async () => {
    const body = `# Proposed\n\n${"full review text\n".repeat(200)}`;
    const current = getTarget(db(), { kind: "section", key: "host_routing" })!;
    const preview = await promptChangePreviewStep({ key: "host_routing", body, note: "rewrite it" });
    expect(preview).toMatchObject({
      ok: true,
      expectedVersion: current.version,
      card: { kind: "prompt_change", currentVersion: current.version, patch: { body } },
    });
    if (!preview.ok) throw new Error("expected valid preview");
    expect(preview.card.diff?.filter((line) => line.op === "add").map((line) => line.text).join("\n"))
      .toContain("full review text");

    const conversationId = "c_prompt_proposal_1";
    ensureConversation(db(), conversationId);
    recordPendingInput(db(), {
      id: "prompt_call_1",
      conversationId,
      kind: "approval",
      question: preview.summary,
      card: preview.card,
    });
    const request = loadPendingRequests(db()).get(conversationId)?.[0];
    expect(request?.toolName).toBe("propose_prompt_change");
    expect(request?.evidence).toBeNull();
    expect(request?.promptChange?.patch.body).toBe(body);
    resolvePendingInput(db(), "prompt_call_1", { approved: false });
  });

  it("a save_skill card is labelled save_skill in the inbox", () => {
    const conversationId = "c_prompt_proposal_skill";
    ensureConversation(db(), conversationId);
    recordPendingInput(db(), {
      id: "prompt_call_skill",
      conversationId,
      kind: "approval",
      question: "Create skill x",
      card: { kind: "prompt_change", target: { kind: "skill", id: "x" }, title: "Create skill x", currentVersion: 0, patch: { body: "b" }, before: null },
    });
    expect(loadPendingRequests(db()).get(conversationId)?.[0]?.toolName).toBe("save_skill");
    resolvePendingInput(db(), "prompt_call_skill", { approved: false });
  });

  it("applies once after approval and conflicts after a concurrent user edit", async () => {
    const preview = await promptChangePreviewStep({ key: "harness_steering", body: "agent steering", note: "tune it" });
    if (!preview.ok) throw new Error("expected valid preview");
    // A concurrent owner edit lands between the proposal and the approval.
    expect(publishEdit(db(), preview.target, { patch: { body: "owner won the race" }, expectedVersion: preview.expectedVersion }))
      .toMatchObject({ ok: true });
    expect(await applyApprovedPromptChangeStep(preview.target, preview.patch, preview.expectedVersion, "tune it"))
      .toMatchObject({ ok: false, code: "conflict" });

    const fresh = await promptChangePreviewStep({ key: "harness_steering", body: "agent steering", note: "tune it" });
    if (!fresh.ok) throw new Error("expected valid preview");
    expect(await applyApprovedPromptChangeStep(fresh.target, fresh.patch, fresh.expectedVersion, "tune it"))
      .toMatchObject({ ok: true });
    expect(getTarget(db(), fresh.target)).toMatchObject({ body: "agent steering", editedBy: "agent" });
  });
});
