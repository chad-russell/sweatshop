import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/settings/test/route";
import { __setGatewayForTests } from "../lib/skills/store";
import { FakeBucket, skillMd } from "./helpers/fake-bucket";

/**
 * 0090 §2: POST /api/settings/test — the handler directly (the route's
 * own tests never touch a network; the skills connector rides the fake
 * bucket seam).
 */

const realFetch = globalThis.fetch;
let bucket: FakeBucket;

beforeEach(() => {
  bucket = new FakeBucket();
  __setGatewayForTests(bucket);
});

afterEach(() => {
  __setGatewayForTests(null);
  globalThis.fetch = realFetch;
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://local/api/settings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/settings/test (0090 §2)", () => {
  it("runs a connector through the real dispatch — skills via the fake bucket", async () => {
    bucket.seed("pdf", skillMd("Make PDFs"));
    const res = await post({ connector: "skills" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, detail: "connected" });
  });

  it("an unknown connector is a value, not an HTTP error", async () => {
    const res = await post({ connector: "bogus" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: false, detail: "unknown connector" });
  });

  it("rejects a missing or non-string connector with a 400", async () => {
    for (const body of [{}, { connector: "" }, { connector: 7 }, "not json"]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
    }
  });
});
