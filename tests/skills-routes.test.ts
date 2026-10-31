import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE } from "../app/api/settings/skills/[id]/route";
import { PUT } from "../app/api/settings/skills/[id]/status/route";
import { __setGatewayForTests, listAllSkills, readSkill } from "../lib/skills/store";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0090 §5: the skill lifecycle routes — handlers directly (dynamic
 * params are promises; the fake bucket is the store).
 */

let bucket: FakeBucket;

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
});

afterEach(() => {
  __setGatewayForTests(null);
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const putRequest = (body?: unknown) =>
  new Request("http://local", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const deleteRequest = () => new Request("http://local", { method: "DELETE" });

describe("PUT /api/settings/skills/[id]/status (0090 §5)", () => {
  it("disables and enables a skill through the store", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    const off = await PUT(putRequest({ disabled: true }), params("pdf"));
    expect(off.status).toBe(200);
    await expect(off.json()).resolves.toMatchObject({ ok: true, id: "pdf" });
    expect((await readSkill("pdf"))?.disabled).toBe(true);

    const on = await PUT(putRequest({ disabled: false }), params("pdf"));
    expect(on.status).toBe(200);
    expect((await readSkill("pdf"))?.disabled).toBe(false);
  });

  it("an unknown id is a 200 value, a malformed body a 400", async () => {
    const unknown = await PUT(putRequest({ disabled: true }), params("nope"));
    expect(unknown.status).toBe(200);
    await expect(unknown.json()).resolves.toMatchObject({ ok: false, code: "unknown-skill" });

    for (const body of [{}, { disabled: "yes" }, undefined]) {
      const res = await PUT(putRequest(body), params("pdf"));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    }
  });

  it("0091 §2: sets an invoke mode, alone or beside disabled (disabled applies first)", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    const mode = await PUT(putRequest({ invoke: "manual" }), params("pdf"));
    expect(mode.status).toBe(200);
    expect((await readSkill("pdf"))?.invoke).toBe("manual");

    const both = await PUT(putRequest({ disabled: true, invoke: "tool" }), params("pdf"));
    expect(both.status).toBe(200);
    const after = await readSkill("pdf");
    expect(after?.disabled).toBe(true);
    expect(after?.invoke).toBe("tool");
  });

  it("0091 §2: a bad invoke value (or an empty body) is a 400", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    for (const body of [{ invoke: "always" }, { invoke: 7 }, { disabled: "yes", invoke: "tool" }]) {
      const res = await PUT(putRequest(body), params("pdf"));
      expect(res.status).toBe(400);
    }
    expect((await readSkill("pdf"))?.invoke).toBe("auto");
  });
});

describe("DELETE /api/settings/skills/[id] (0090 §5)", () => {
  it("deletes the skill's object family", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"), { "ref.md": "r" });
    const res = await DELETE(deleteRequest(), params("pdf"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, id: "pdf" });
    expect(await listAllSkills()).toEqual([]);
  });

  it("an unknown id is a 200 value", async () => {
    const res = await DELETE(deleteRequest(), params("nope"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: false, code: "unknown-skill" });
  });
});
