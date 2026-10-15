import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { start } from "workflow/api";
import { db } from "../db";
import { ensureConversation, listMessageTexts, listModelMessages } from "../db/chat";
import { getAttachments, insertAttachment, sweepUnclaimed, UNCLAIMED_TTL_MS } from "../db/attachments";
import { deleteConversationForever } from "../db/organize";
import { chatTurn } from "../workflows/chat/turn";
import { rowsToUIMessages } from "../lib/chat-ui";
import { attachmentsDir, readAttachmentFile, sniffImage } from "../lib/attachments";
import { POST as upload } from "../app/api/x/attachments/route";
import { GET as serve } from "../app/api/attachments/[id]/route";
import { POST as postChat } from "../app/api/x/chat/route";
import { startWorkflowExecutor, type WorkflowExecutor } from "./helpers/workflow-executor";

/**
 * 0042: image attachments — upload, the model seeing bytes (never the
 * `attachment:` reference), history, reload, sweep and teardown. All
 * against the scripted mock model.
 */

process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(tmpdir(), "sweatshop-att-"));

// Minimal valid headers; the sniffer only needs the magic bytes.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);

async function up(bytes: Uint8Array, name = "x.png", type = "image/png") {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type }));
  return upload(new Request("http://x/api/x/attachments", { method: "POST", body: form }));
}

function conv(name: string): string {
  const id = `c_att_${name}_${Math.random().toString(36).slice(2, 8)}`;
  ensureConversation(db(), id);
  return id;
}

describe("sniffImage", () => {
  it("identifies by magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
});

describe("POST /api/x/attachments", () => {
  it("stores a PNG, returns its id and serves it back with the sniffed type", async () => {
    const res = await up(PNG);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toMatch(/^att_[a-z0-9]+$/);
    expect(body.mediaType).toBe("image/png");
    expect(getAttachments(db(), [body.id])[0]).toMatchObject({ mediaType: "image/png", bytes: PNG.length, conversationId: null });
    const served = await serve(new Request("http://x"), { params: Promise.resolve({ id: body.id }) });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("trusts the bytes, not the client's MIME or filename", async () => {
    const liar = await up(JPEG, "evil.png", "image/png");
    expect((await liar.json()).mediaType).toBe("image/jpeg");
    const notImage = await up(new TextEncoder().encode("<html>"), "a.png", "image/png");
    expect(notImage.status).toBe(415);
  });

  it("enforces the size cap and the form shape", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await up(big)).status).toBe(413);
    const json = await upload(new Request("http://x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(json.status).toBe(400);
    const empty = await upload(new Request("http://x", { method: "POST", body: new FormData() }));
    expect(empty.status).toBe(400);
  });

  it("serving rejects bad and unknown ids", async () => {
    expect((await serve(new Request("http://x"), { params: Promise.resolve({ id: "../etc/passwd" }) })).status).toBe(400);
    expect((await serve(new Request("http://x"), { params: Promise.resolve({ id: "att_nope" }) })).status).toBe(404);
  });
});

describe("POST /api/x/chat with images (validation)", () => {
  const send = (body: unknown) =>
    postChat(new Request("http://x/api/x/chat", { method: "POST", body: JSON.stringify(body) }));
  const msg = (text: string, ids: string[]) => ({
    role: "user",
    parts: [...(text ? [{ type: "text", text }] : []), ...ids.map((id) => ({ type: "file", mediaType: "image/png", url: `/api/attachments/${id}` }))],
  });

  it("rejects unknown ids, over-limit sends and empty sends — creating nothing", async () => {
    const unknown = await send({ conversationId: "c_attv_1", messages: [msg("hi", ["att_doesnotexist"])] });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toContain("unknown attachment");

    const many = await send({ conversationId: "c_attv_2", messages: [msg("hi", ["att_a", "att_b", "att_c", "att_d", "att_e"])] });
    expect(many.status).toBe(400);
    expect((await many.json()).error).toContain("at most 4");

    const empty = await send({ conversationId: "c_attv_3", messages: [msg("", [])] });
    expect(empty.status).toBe(400);

    const bad = await send({ conversationId: "c_attv_4", messages: [msg("hi", ["../x"])] });
    expect(bad.status).toBe(400);

    const { getConversation } = await import("../db/chat");
    for (const id of ["c_attv_1", "c_attv_2", "c_attv_3", "c_attv_4"]) expect(getConversation(db(), id)).toBeNull();
  });

  it("rejects an attachment claimed by another conversation", async () => {
    const { id } = await (await up(PNG)).json();
    const owner = conv("owner");
    const { claimAttachments } = await import("../db/attachments");
    claimAttachments(db(), [id], owner);
    const res = await send({ conversationId: "c_attv_5", messages: [msg("hi", [id])] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("another conversation");
  });
});

describe("0042: the turn sees image bytes, not references", () => {
  let executor: WorkflowExecutor;
  beforeAll(async () => {
    executor = await startWorkflowExecutor();
  }, 120_000);
  afterAll(async () => {
    await executor?.close();
  });

  const turn = (conversationId: string, userText: string, attachments?: string[]) =>
    start(chatTurn, [{ conversationId, userText, ...(attachments ? { attachments } : {}) }]);
  const lastReply = (id: string) => {
    const rows = listModelMessages(db(), id);
    return JSON.stringify(rows.at(-1));
  };

  it(
    "resolves the reference to bytes inside the step; the row stores only the reference; history re-resolves next turn",
    { timeout: 40_000 },
    async () => {
      process.env.SWEATSHOP_CHAT_MOCK = "images";
      const { id } = await (await up(PNG)).json();
      const cid = conv("bytes");

      await (await turn(cid, "what is this?", [id])).returnValue;

      // The stored user row: text + an attachment reference, no bytes.
      const stored = JSON.stringify(listModelMessages(db(), cid)[0]);
      expect(stored).toContain(`attachment:${id}`);
      expect(stored).not.toContain("iVBOR"); // no base64 PNG in sqlite
      expect(listMessageTexts(db(), cid)[0]!.text).toBe("what is this?");
      // The attachment is claimed by the conversation.
      expect(getAttachments(db(), [id])[0]!.conversationId).toBe(cid);

      // The mock saw real bytes (size + media type), not a URL.
      expect(lastReply(cid)).toContain(`mock-images:bytes:${PNG.length}:image/png`);
      expect(lastReply(cid)).not.toContain("url:");

      // Next turn: the old image is resolved again from history.
      await (await turn(cid, "and now?")).returnValue;
      expect(lastReply(cid)).toContain(`bytes:${PNG.length}:image/png`);
    },
  );

  it("image-only sends work (no text part)", { timeout: 40_000 }, async () => {
    process.env.SWEATSHOP_CHAT_MOCK = "images";
    const { id } = await (await up(JPEG)).json();
    const cid = conv("only");
    await (await turn(cid, "", [id])).returnValue;
    expect(lastReply(cid)).toContain(`bytes:${JPEG.length}:image/jpeg`);
  });

  it("a missing file degrades to a placeholder instead of breaking the conversation", { timeout: 40_000 }, async () => {
    process.env.SWEATSHOP_CHAT_MOCK = "images";
    const { id } = await (await up(PNG)).json();
    const cid = conv("gone");
    await (await turn(cid, "look", [id])).returnValue;
    const { removeAttachmentFiles } = await import("../lib/attachments");
    await removeAttachmentFiles(id);
    expect(await readAttachmentFile(id)).toBeNull();
    await (await turn(cid, "again")).returnValue;
    expect(lastReply(cid)).toContain("[image unavailable]");
  });

  it(
    "recorded step inputs carry the attachment reference, never the image's bytes",
    { timeout: 60_000 },
    async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const zlib = await import("node:zlib");
      {
        process.env.SWEATSHOP_CHAT_MOCK = "images";
        // A distinctive payload so a leak is unmistakable.
        const marker = Buffer.from("SWEATSHOP-IMAGE-LEAK-CANARY-0042-xxxxxxxx");
        const payload = Uint8Array.from([...PNG.slice(0, 8), ...marker]);
        const { id } = await (await up(payload)).json();
        const cid = conv("canary");
        await (await start(chatTurn, [{ conversationId: cid, userText: "canary", attachments: [id] }])).returnValue;

        // The marker as raw text and as base64 at each of the 3 alignments
        // (recorded Uint8Arrays are base64 inside the event JSON).
        const needles = [
          marker.toString("latin1"),
          ...[0, 1, 2].map((pad) => Buffer.concat([Buffer.alloc(pad), marker]).toString("base64").slice(4, 28)),
        ];

        // Recorded payloads are `devl` (devalue, plain) or `zstd` (compressed)
        // behind a 4-byte format prefix, base64 in a {__type:"Uint8Array"} cell.
        const decode = (b64: string): string => {
          const raw = Buffer.from(b64, "base64");
          const prefix = raw.subarray(0, 4).toString("latin1");
          const body = raw.subarray(4);
          return (prefix === "zstd"
            ? (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(body)
            : body
          ).toString("latin1");
        };
        const events = path.join(process.env.WORKFLOW_LOCAL_DATA_DIR!, "events");
        let decoded = 0;
        let sawReference = false;
        const hits: string[] = [];
        for (const name of readdirSync(events)) {
          const full = path.join(events, name);
          if (!statSync(full).isFile()) continue;
          const file = readFileSync(full, "utf8");
          const json = JSON.parse(file);
          const cell = json.eventData?.input ?? json.eventData?.result;
          const texts = [file];
          if (cell?.__type === "Uint8Array" && typeof cell.data === "string") {
            texts.push(decode(cell.data));
            decoded += 1;
          }
          for (const t of texts) {
            if (t.includes(`attachment:${id}`)) sawReference = true;
            if (needles.some((n) => t.includes(n))) hits.push(`${name}`);
          }
        }
        // Positive controls: we really decoded recorded payloads and the
        // reference IS in them — so the absence of bytes is meaningful.
        expect(decoded).toBeGreaterThan(0);
        expect(sawReference).toBe(true);
        expect(hits).toEqual([]);
      }
    },
  );
});

describe("reload, sweep and teardown", () => {
  it("rowsToUIMessages turns stored image parts into file parts above the text", () => {
    const rows = [
      {
        id: "t_1",
        role: "user",
        text: "hi",
        at: 1,
        modelMessage: {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "hi" },
            { type: "file" as const, data: "attachment:att_abc123", mediaType: "image/png" },
          ],
        },
        metadata: null,
      },
    ];
    const [m] = rowsToUIMessages(rows);
    expect(m!.parts).toEqual([
      { type: "file", mediaType: "image/png", url: "/api/attachments/att_abc123" },
      { type: "text", text: "hi" },
    ]);
  });

  it("sweeps unclaimed uploads past 24 h with their files; keeps claimed and fresh ones", async () => {
    const now = Date.now();
    const old = (await (await up(PNG)).json()).id as string;
    const fresh = (await (await up(PNG)).json()).id as string;
    const claimed = (await (await up(PNG)).json()).id as string;
    const owner = conv("sweepkeep");
    const { claimAttachments } = await import("../db/attachments");
    claimAttachments(db(), [claimed], owner);
    // Backdate the old and claimed rows.
    const { attachments } = await import("../db/schema");
    const { inArray } = await import("drizzle-orm");
    db().update(attachments).set({ createdAt: now - UNCLAIMED_TTL_MS - 1000 }).where(inArray(attachments.id, [old, claimed])).run();

    const swept = sweepUnclaimed(db(), now);
    expect(swept).toContain(old);
    expect(swept).not.toContain(fresh);
    expect(swept).not.toContain(claimed);
    const { removeAttachmentFiles } = await import("../lib/attachments");
    await Promise.all(swept.map(removeAttachmentFiles));
    expect(await readAttachmentFile(old)).toBeNull();
    expect(await readAttachmentFile(fresh)).not.toBeNull();
    expect(await readAttachmentFile(claimed)).not.toBeNull();
  });

  it("deleting a conversation forever removes its attachment rows and files", async () => {
    const { id } = await (await up(PNG)).json();
    const cid = conv("teardown");
    const { claimAttachments } = await import("../db/attachments");
    claimAttachments(db(), [id], cid);
    const file = (await readAttachmentFile(id))!.file;
    expect(existsSync(file)).toBe(true);
    deleteConversationForever(db(), cid);
    expect(getAttachments(db(), [id])).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(attachmentsDir()).toBe(process.env.ATTACHMENTS_DIR);
  });

  it("0035 screenshots (plain files, no row) are unaffected by the sweep", async () => {
    const { writeFile } = await import("node:fs/promises");
    const id = "att_screenshot0035";
    await writeFile(path.join(attachmentsDir(), `${id}.png`), PNG);
    sweepUnclaimed(db(), Date.now() + 10 * UNCLAIMED_TTL_MS);
    expect(await readAttachmentFile(id)).not.toBeNull();
    // and unused import guard
    insertAttachment;
  });
});
