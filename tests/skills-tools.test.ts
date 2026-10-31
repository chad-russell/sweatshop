import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { ensureConversation, getPendingInputCard, listPendingInputs } from "../db/chat";
import { loadHarnessSkills } from "../lib/harness-skills";
import { __setGatewayForTests } from "../lib/skills/store";
import { buildChatTools } from "../workflows/chat/tools";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0088: use_skill file reads, save_skill validation/approval flow, and
 * the harness mount mapping — all against a fake bucket.
 */

let bucket: FakeBucket;
const cid = "c_0088_tools";

type Exec = (input: Record<string, unknown>, ctx: { toolCallId: string }) => Promise<unknown>;
const tool = (name: "use_skill" | "save_skill") =>
  (buildChatTools(cid, { hasSandbox: false, hasProject: false }) as unknown as Record<string, { execute: Exec }>)[name]!.execute;

beforeEach(() => {
  ensureConversation(db(), cid);
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
});

afterEach(() => __setGatewayForTests(null));

// Outside a workflow run chatApprovalHook.create() throws
// NotInWorkflowContextError — everything before the hook already ran.
async function untilHook(call: Promise<unknown>) {
  try {
    return await call;
  } catch (err) {
    if (err instanceof Error && err.name === "NotInWorkflowContextError") return undefined;
    throw err;
  }
}

describe("use_skill", () => {
  it("lists skills with descriptions, invoke modes, and files", async () => {
    bucket.seed("a", skillMd("Does A"), { "ref.md": "r" });
    bucket.seed("scraper", skillMd("Scrapes", "# Scrape.", "invoke: tool\n"));
    bucket.seed("secret", skillMd("Secret", "# Shh.", "invoke: manual\n"));
    const res = (await tool("use_skill")({}, { toolCallId: "t1" })) as { skills: unknown[] };
    // 0091 §2: manual skills are never listed; tool rows are marked.
    expect(res).toEqual({
      ok: true,
      skills: [
        { id: "a", description: "Does A", invoke: "auto", files: ["ref.md"] },
        { id: "scraper", description: "Scrapes", invoke: "tool", files: [] },
      ],
    });
  });

  it("0091 §2: a manual skill is unread by list but an explicit id still loads it", async () => {
    bucket.seed("secret", skillMd("Only on purpose", "# Shh."));
    const byId = (await tool("use_skill")({ id: "secret" }, { toolCallId: "t1" })) as { ok: boolean; skill: string };
    expect(byId.ok).toBe(true);
    expect(byId.skill).toContain("# Shh.");
  });

  it("loads the body plus a Files line when the skill has files", async () => {
    bucket.seed("a", skillMd("Does A", "# A\n\nSteps."), { "ref.md": "r", "x/y.md": "y" });
    const res = (await tool("use_skill")({ id: "a" }, { toolCallId: "t1" })) as { ok: boolean; skill: string };
    expect(res.ok).toBe(true);
    expect(res.skill).toBe("# A\n\nSteps.\n\nFiles: ref.md, x/y.md");
  });

  it("loads a body with no Files line when there are none", async () => {
    bucket.seed("a", skillMd("Does A", "# A"));
    const res = (await tool("use_skill")({ id: "a" }, { toolCallId: "t1" })) as { skill: string };
    expect(res.skill).toBe("# A");
  });

  it("loads a supporting file", async () => {
    bucket.seed("a", skillMd("Does A"), { "ref.md": "reference text" });
    expect(await tool("use_skill")({ id: "a", file: "ref.md" }, { toolCallId: "t1" })).toEqual({
      ok: true,
      id: "a",
      file: "ref.md",
      content: "reference text",
    });
  });

  it("an unknown file is a value-shaped error listing what exists", async () => {
    bucket.seed("a", skillMd("Does A"), { "ref.md": "r", "b.md": "b" });
    const res = (await tool("use_skill")({ id: "a", file: "nope.md" }, { toolCallId: "t1" })) as { ok: boolean; code: string; message: string };
    expect(res).toMatchObject({ ok: false, code: "unknown-file" });
    expect(res.message).toContain("b.md, ref.md");
  });

  it("unknown and disabled skills are value-shaped with the catalog", async () => {
    bucket.seed("off", skillMd("Hidden", "# x", "status: disabled\n"));
    bucket.seed("on", skillMd("Visible"));
    expect(await tool("use_skill")({ id: "off" }, { toolCallId: "t1" })).toMatchObject({ ok: false, code: "unknown-skill", skills: [{ id: "on" }] });
    expect(await tool("use_skill")({ id: "ghost" }, { toolCallId: "t2" })).toMatchObject({ ok: false, code: "unknown-skill" });
  });
});

describe("save_skill", () => {
  it("invalid input returns value-shaped before any pending row opens", async () => {
    const res = await tool("save_skill")({ id: "Bad Id", body: "no front matter" }, { toolCallId: "sv_bad" });
    expect(res).toMatchObject({ ok: false, code: "invalid" });
    expect((res as { issues: string[] }).issues.length).toBeGreaterThan(1);
    expect(listPendingInputs(db(), cid)).toHaveLength(0);
    expect(bucket.puts).toEqual([]);
  });

  it("an unconfigured store refuses before asking", async () => {
    __setGatewayForTests(null);
    const res = await tool("save_skill")({ id: "a", body: skillMd("x") }, { toolCallId: "sv_unconf" });
    expect(res).toMatchObject({ ok: false, code: "unconfigured" });
    expect(listPendingInputs(db(), cid)).toHaveLength(0);
  });

  it("a new skill opens an approval card with the full content and writes nothing yet", async () => {
    await untilHook(tool("save_skill")({ id: "fresh", body: skillMd("Brand new", "# Fresh"), files: [{ path: "ref.md", content: "R" }] }, { toolCallId: "sv_new" }));
    expect(listPendingInputs(db(), cid).map((p) => p.id)).toContain("sv_new");
    const card = getPendingInputCard(db(), "sv_new") as { kind: string; title: string; diff: { op: string; text: string }[] };
    expect(card).toMatchObject({ kind: "prompt_change", title: "Create skill fresh" });
    expect(card.diff.every((l) => l.op === "add")).toBe(true);
    expect(card.diff.map((l) => l.text)).toContain("=== ref.md ===");
    expect(bucket.puts).toEqual([]);
  });

  it("an edit's card is a unified diff against the stored version", async () => {
    bucket.seed("a", skillMd("Old desc", "# A\n\nstep one"), { "ref.md": "same" });
    await untilHook(tool("save_skill")({ id: "a", body: skillMd("Old desc", "# A\n\nstep two"), files: [{ path: "ref.md", content: "same" }] }, { toolCallId: "sv_edit" }));
    const card = getPendingInputCard(db(), "sv_edit") as { title: string; diff: { op: string; text: string }[] };
    expect(card.title).toBe("Change skill a");
    expect(card.diff).toContainEqual({ op: "del", text: "step one" });
    expect(card.diff).toContainEqual({ op: "add", text: "step two" });
    expect(card.diff).toContainEqual({ op: "same", text: "same" });
    expect(bucket.puts).toEqual([]);
  });
});

describe("loadHarnessSkills", () => {
  it("maps the catalog to HarnessV1Skills: body with owner placeholders rendered, files, no disabled", async () => {
    process.env.SWEATSHOP_OWNER_NAME = "Pat";
    try {
      bucket.seed("ship", skillMd("Ship for {{owner}}", "# Ship\n\nAsk {{owner}}."), { "ref.md": "r" });
      bucket.seed("off", skillMd("Hidden", "# x", "status: disabled\n"));
      bucket.seed("hands", skillMd("Manual", "# x", "invoke: manual\n"));
      bucket.seed("wired", skillMd("Wired", "# x", "invoke: tool\n"));
      const skills = await loadHarnessSkills();
      // 0091 §2: manual never mounts; tool does.
      expect(skills).toEqual([
        { name: "ship", description: "Ship for Pat", content: "# Ship\n\nAsk Pat.", files: [{ path: "ref.md", content: "r" }] },
        { name: "wired", description: "Wired", content: "# x", files: [] },
      ]);
    } finally {
      delete process.env.SWEATSHOP_OWNER_NAME;
    }
  });

  it("is empty (never throws) when the store is down or unconfigured", async () => {
    bucket.failList = new Error("down");
    expect(await loadHarnessSkills()).toEqual([]);
    __setGatewayForTests(null);
    expect(await loadHarnessSkills()).toEqual([]);
  });
});
