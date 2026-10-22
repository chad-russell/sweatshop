import { describe, expect, it } from "vitest";
import { db } from "../db";
import { createHarnessCall, getHarnessCall, settleHarnessCall } from "../db/harness-calls";
import { ensureConversation } from "../db/chat";
import { projects } from "../db/schema";
import { POST as cancelRoute } from "../app/api/x/harness-calls/[id]/cancel/route";

/**
 * 0063: POST /api/x/harness-calls/[id]/cancel — the session/card Cancel
 * button's route. Same semantics as the agent's own cancel_run tool,
 * scoped to hc_… ids only (see tests/harness-calls.test.ts for the
 * tool-level coverage of cancelRunTool itself).
 */

db().insert(projects).values({ id: "p_hcroute", name: "HC Route", createdAt: 0 }).onConflictDoNothing().run();
let n = 0;
const newConv = () => {
  const id = `c_hcroute_${++n}`;
  ensureConversation(db(), id, "p_hcroute");
  return id;
};

function runningCall() {
  const conversationId = newConv();
  return createHarnessCall(db(), { conversationId, kind: "pi", task: `task ${++n}` });
}

const post = (id: string) => cancelRoute(new Request(`http://x/api/x/harness-calls/${id}/cancel`, { method: "POST" }), {
  params: Promise.resolve({ id }),
});

describe("POST /api/x/harness-calls/[id]/cancel", () => {
  it("cancels a running call: 200 + the row settles cancelled", async () => {
    const call = runningCall();
    const res = await post(call.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body).toMatchObject({ ok: true, status: "cancelled" });
    expect(getHarnessCall(db(), call.id)?.status).toBe("cancelled");
  });

  it("rejects an already-settled call with 409", async () => {
    const call = runningCall();
    settleHarnessCall(db(), call.id, { status: "completed", result: "done" });
    const res = await post(call.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: "not-live" });
  });

  it("404s an unknown hc_ id", async () => {
    const res = await post("hc_doesnotexist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; code: string };
    expect(body).toMatchObject({ ok: false, code: "not-found" });
  });

  it("400s a non-hc id", async () => {
    const res = await post("c_someconversation");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("c_someconversation");
  });
});
