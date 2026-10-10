import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Experimental_SandboxSession } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  appendMessages,
  ensureConversation,
  getPendingInputCard,
  listPendingInputs,
  recordPendingInput,
} from "../db/chat";
import { loadPendingRequests } from "../db/attention";
import { bindConversation } from "../db/sandboxes";
import { conversations, harnessEvents, messages, pendingInputs, projects } from "../db/schema";
import { recordHarnessEvent } from "../lib/harness-events";
import {
  buildApprovalEvidence,
  collectThreadEvidence,
  describeCheck,
  shotsFromMessages,
  runCheck,
} from "../lib/agent/tools/evidence";
import { answerPendingWithText } from "../lib/chat/answer-pending";
import type { SandboxHandle, SandboxProvider } from "../lib/sandboxes/provider";

/**
 * 0037 phase 1: runtime-built evidence on gated cards, and typing while
 * an approval waits = a revise. The evidence collector reads the
 * thread's own tool results (the agent-stage gap run 4 hit) and its
 * harness calls' events; the check runs the project's test command
 * through the sandbox runner.
 */

const rand = Math.random().toString(36).slice(2, 8);
const pid = `ev-${rand}`;
const conv = `c_test_ev_${rand}`;

class ScriptedProvider implements SandboxProvider {
  readonly kind = "fake";
  commands: string[] = [];
  constructor(private result: { exitCode: number; stdout: string; stderr: string }) {}
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command) => {
        this.commands.push(command);
        return this.result;
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop() {}
  async resume() {}
  async destroy() {}
}

function shot(id: string, label: string, url: string | null) {
  appendMessages(db(), conv, [
    {
      id: `${id}_a`,
      role: "assistant",
      text: "",
      modelMessage: {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "attach_screenshot", input: { path: "/x.png", label } }],
      },
    },
    {
      id: `${id}_t`,
      role: "tool",
      text: "",
      modelMessage: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: "attach_screenshot",
            output: {
              type: "json",
              value: url ? { ok: true, url, id: "att" } : { ok: false, code: "not-png", message: "no" },
            },
          },
        ],
      },
    },
  ]);
}

beforeAll(() => {
  db().insert(projects).values({ id: pid, name: "Evidence", createdAt: 0, testCommand: "npm test" }).run();
  ensureConversation(db(), conv, pid);
});

afterAll(() => {
  db().delete(messages).where(eq(messages.conversationId, conv)).run();
  db().delete(harnessEvents).where(eq(harnessEvents.sessionId, conv)).run();
  db().delete(pendingInputs).where(eq(pendingInputs.conversationId, conv)).run();
  db().delete(conversations).where(eq(conversations.id, conv)).run();
  db().delete(projects).where(eq(projects.id, pid)).run();
});

describe("collectThreadEvidence", () => {
  it("reads the thread's attach_screenshot results (with labels) and its harness calls' events", () => {
    shot("call_1", "before", "/api/attachments/att_1");
    shot("call_2", "broken", null); // failed attach — not evidence
    shot("call_3", "after", "/api/attachments/att_3");
    recordHarnessEvent(conv, "claude", {
      kind: "tool-start",
      toolName: "attach_screenshot",
      toolCallId: "h1",
      input: JSON.stringify({ path: "/y.png", label: "narrow" }),
    });
    recordHarnessEvent(conv, "claude", {
      kind: "tool-end",
      toolName: "attach_screenshot",
      toolCallId: "h1",
      output: JSON.stringify({ ok: true, url: "/api/attachments/att_h" }),
    });
    expect(collectThreadEvidence(conv)).toEqual([
      { url: "/api/attachments/att_1", label: "before" },
      { url: "/api/attachments/att_3", label: "after" },
      { url: "/api/attachments/att_h", label: "narrow" },
    ]);
  });
});

describe("live turn evidence (run 5)", () => {
  it("reads this turn's unpersisted attachments, de-duplicated against persisted ones", () => {
    const live = [
      {
        role: "assistant" as const,
        content: [{ type: "tool-call" as const, toolCallId: "live_1", toolName: "attach_screenshot", input: { path: "/z.png", label: "after-70vh" } }],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "live_1",
            toolName: "attach_screenshot",
            output: { type: "json" as const, value: { ok: true, url: "/api/attachments/att_live" } },
          },
          {
            type: "tool-result" as const,
            toolCallId: "call_1",
            toolName: "attach_screenshot",
            output: { type: "json" as const, value: { ok: true, url: "/api/attachments/att_1" } },
          },
        ],
      },
    ];
    const shots = collectThreadEvidence(conv, live);
    expect(shots.filter((s) => s.url === "/api/attachments/att_1")).toHaveLength(1);
    expect(shots.at(-2)).toEqual({ url: "/api/attachments/att_live", label: "after-70vh" });
    expect(shotsFromMessages(live)).toHaveLength(2);
  });
});

describe("runCheck", () => {
  it("passes on exit 0, fails with a tail, and marks timeouts", async () => {
    const ok = await runCheck(async () => ({ exitCode: 0, stdout: "all green\n", stderr: "" }), "npm test", "r");
    expect(ok).toMatchObject({ status: "passed", exitCode: 0, command: "npm test" });

    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const bad = await runCheck(async () => ({ exitCode: 1, stdout: long, stderr: "" }), "npm test", "r");
    expect(bad.status).toBe("failed");
    expect(bad.tail).toContain("line 59");
    expect(bad.tail).not.toContain("line 10\n");

    const slow = await runCheck(async () => ({ exitCode: 124, stdout: "", stderr: "" }), "npm test", "r");
    expect(slow.status).toBe("timed-out");

    let seen = "";
    await runCheck(async (c) => ((seen = c), { exitCode: 0, stdout: "", stderr: "" }), "echo 'hi'", "my-repo");
    expect(seen).toContain("cd 'my-repo'");
    expect(seen).toContain(`bash -lc 'echo '\\''hi'\\'''`);
  });
});

describe("buildApprovalEvidence", () => {
  it("notes an unbound conversation instead of provisioning a sandbox to test", async () => {
    const provider = new ScriptedProvider({ exitCode: 0, stdout: "", stderr: "" });
    const evidence = await buildApprovalEvidence(conv, "r", provider);
    expect(evidence.check).toBeNull();
    expect(evidence.checkNote).toContain("no sandbox bound");
    expect(provider.commands).toEqual([]);
    expect(evidence.screenshots).toHaveLength(3);
  });

  it("runs the project's test command in the bound sandbox", async () => {
    db().$client
      .prepare(
        "insert into sandboxes (id, provider, ref, owner_kind, owner_id, status, last_used_at, created_at) " +
          "values (?, 'fake', ?, 'conversation', ?, 'running', ?, 0)",
      )
      .run(`sbx_ev_${rand}`, `ref-ev-${rand}`, conv, Date.now());
    bindConversation(db(), conv, { kind: "bound", sandboxId: `sbx_ev_${rand}`, workDir: `/work/${conv}`, owner: true });
    const provider = new ScriptedProvider({ exitCode: 1, stdout: "1 failing\n", stderr: "" });
    const evidence = await buildApprovalEvidence(conv, "r", provider);
    expect(evidence.check).toMatchObject({ status: "failed", exitCode: 1, command: "npm test" });
    expect(provider.commands.some((c) => c.includes("timeout") && c.includes("npm test"))).toBe(true);
    expect(describeCheck(evidence)).toContain("tests failed (exit 1)");
  });

  it("is null-check when the project has no test command", async () => {
    const plain = `c_test_ev_plain_${rand}`;
    ensureConversation(db(), plain);
    const evidence = await buildApprovalEvidence(plain, "r");
    expect(evidence).toEqual({ screenshots: [], check: null });
    db().delete(conversations).where(eq(conversations.id, plain)).run();
  });
});

describe("pending card + typing-revises", () => {
  it("stores the card on the pending row and surfaces it on the inbox request", () => {
    const card = { screenshots: [{ url: "/api/attachments/att_1" }], check: null };
    recordPendingInput(db(), { id: `pr_${rand}`, conversationId: conv, kind: "approval", question: "Open a PR", card });
    expect(getPendingInputCard(db(), `pr_${rand}`)).toEqual(card);
    const request = loadPendingRequests(db(), [conv]).get(conv)?.[0];
    expect(request?.evidence).toEqual(card);
    expect(getPendingInputCard(db(), "nope")).toBeNull();
  });

  it("answers the oldest pending approval as a denial carrying the typed text", async () => {
    const calls: [string, unknown][] = [];
    const answered = await answerPendingWithText(conv, "make it 896px, not 1024", {
      resume: async (token, payload) => void calls.push([token, payload]),
    });
    expect(answered).toEqual({ toolCallId: `pr_${rand}`, kind: "approval" });
    expect(calls).toEqual([
      [`pr_${rand}`, { kind: "approval", approved: false, comment: "make it 896px, not 1024" }],
    ]);
    expect(listPendingInputs(db(), conv)).toEqual([]);
  });

  it("answers a pending question with the text, and is null when nothing waits", async () => {
    recordPendingInput(db(), { id: `q_${rand}`, conversationId: conv, kind: "question", question: "Which repo?" });
    const calls: unknown[] = [];
    const answered = await answerPendingWithText(conv, "gpl", { resume: async (_t, p) => void calls.push(p) });
    expect(answered?.kind).toBe("question");
    expect(calls).toEqual([{ kind: "question", answer: "gpl" }]);
    expect(await answerPendingWithText(conv, "hello", { resume: async () => undefined })).toBeNull();
  });

  it("leaves the row pending when the hook will not resume (no lost message)", async () => {
    recordPendingInput(db(), { id: `gone_${rand}`, conversationId: conv, kind: "approval", question: "x" });
    const answered = await answerPendingWithText(conv, "text", {
      resume: async () => {
        throw new Error("hook not found");
      },
    });
    expect(answered).toBeNull();
    expect(listPendingInputs(db(), conv).map((p) => p.id)).toContain(`gone_${rand}`);
  });
});
