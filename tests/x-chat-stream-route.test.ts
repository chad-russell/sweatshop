import { describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/x/chat/[runId]/from/[cursor]/stream/route";

/**
 * 0077: the cursor-based reconnect route — `[runId]/from/[cursor]/
 * stream`. Validates both path segments (cursor, the raw-journal start;
 * startIndex, the UI-chunk query param the transport appends on its own
 * reconnect retries) and wires them to `getReadable({ startIndex:
 * cursor })`, same mocking pattern as the existing `[runId]/stream`
 * route's tests (x-chat-route.test.ts).
 */

const { getRunMock, getReadableMock } = vi.hoisted(() => ({
  getRunMock: vi.fn(),
  getReadableMock: vi.fn(),
}));
vi.mock("workflow/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("workflow/api")>();
  return { ...actual, getRun: (runId: string) => getRunMock(runId) };
});

function request(query?: string) {
  return new Request(`http://x/api/x/chat/run_1/from/5/stream${query ? `?${query}` : ""}`);
}

function call(runId: string, cursor: string, query?: string) {
  return GET(request(query), { params: Promise.resolve({ runId, cursor }) });
}

describe("GET /api/x/chat/[runId]/from/[cursor]/stream", () => {
  it("rejects a non-integer cursor with 400 before ever asking the run", async () => {
    for (const bad of ["abc", "-1", "1.5"]) {
      const res = await call("run_1", bad);
      expect(res.status).toBe(400);
    }
    expect(getRunMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer startIndex with 400", async () => {
    getRunMock.mockReturnValue({ exists: Promise.resolve(true), getReadable: getReadableMock });
    const res = await call("run_1", "5", "startIndex=abc");
    expect(res.status).toBe(400);
  });

  it("404s an unknown run", async () => {
    getRunMock.mockReturnValue({ exists: Promise.resolve(false), getReadable: getReadableMock });
    const res = await call("run_missing", "0");
    expect(res.status).toBe(404);
    expect(getRunMock).toHaveBeenCalledWith("run_missing");
  });

  it("reads the run's stream from the path cursor, not index 0", async () => {
    getReadableMock.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", text: "resumed" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.close();
        },
      }),
    );
    getRunMock.mockReturnValue({ exists: Promise.resolve(true), getReadable: getReadableMock });

    // No query startIndex: the UI transform's own cursor starts at 0, so
    // all three raw parts survive it — isolates the PATH cursor's wiring
    // (asserted below) from the UI chunk offset (covered next).
    const res = await call("run_1", "42");

    expect(res.status).toBe(200);
    expect(res.headers.get("x-workflow-run-id")).toBe("run_1");
    // The raw-journal cursor comes from the PATH, never the query.
    expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 42 });
    const parts = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(5).trim()) as { type: string; delta?: string });
    expect(parts.find((p) => p.type === "text-delta")?.delta).toBe("resumed");
  });

  it("offsets by the query startIndex (the UI chunks the transport already received)", async () => {
    getReadableMock.mockReturnValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "t1" });
          controller.enqueue({ type: "text-delta", id: "t1", text: "resumed" });
          controller.enqueue({ type: "text-end", id: "t1" });
          controller.close();
        },
      }),
    );
    getRunMock.mockReturnValue({ exists: Promise.resolve(true), getReadable: getReadableMock });

    // A startIndex past every UI chunk this (fake) raw stream produces —
    // every one of them is a retry-replay the client already has, so
    // none should be re-emitted.
    const res = await call("run_1", "42", "startIndex=99");

    expect(res.status).toBe(200);
    const parts = (await res.text())
      .split("\n")
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(5).trim()) as { type: string });
    expect(parts).toEqual([]);
  });
});
