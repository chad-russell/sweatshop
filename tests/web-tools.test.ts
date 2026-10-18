import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWebPage, htmlToText } from "../lib/agent/tools/web";
import { searchWeb } from "../lib/agent/tools/web-search";

/**
 * 1.5 (roadmap): the web tool cores against a stubbed global fetch —
 * no network in the gate. The live endpoint was verified by hand
 * (2026-10-08 spike): initialize + tools/call over SSE, the payload
 * double-encoded; the stubs below replay that shape.
 */

const PAGE = `<!doctype html>
<html><head><title>Docs &amp; Guides</title><style>body{color:red}</style></head>
<body>
  <!-- comment -->
  <script>document.cookie = "x";</script>
  <h1>Hello&nbsp;World</h1>
  <p>First &lt;paragraph&gt; with a <a href="/x">link</a>.</p>
  <div>Second block &#8212; after div</div>
</body></html>`;

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("htmlToText", () => {
  it("keeps the title, drops script/style/comments, breaks blocks, decodes entities", () => {
    const { title, text } = htmlToText(PAGE);
    expect(title).toBe("Docs & Guides");
    expect(text).toContain("Hello World");
    expect(text).toContain("First <paragraph> with a link.");
    expect(text).toContain("Second block — after div");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("document.cookie");
    expect(text).not.toContain("<!--");
    expect(text).not.toMatch(/<\/?(html|head|body|div|p|h1|a|script|style)\b/i);
  });
});

describe("fetchWebPage", () => {
  it("returns the stripped page with status, content type and byte count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(PAGE)));
    const result = await fetchWebPage("https://example.com/docs");
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      contentType: "text/html",
      title: "Docs & Guides",
      truncated: false,
      textClipped: false,
    });
    expect(result.ok && result.text).toContain("First <paragraph>");
    expect(result.ok && result.bytes).toBeGreaterThan(0);
    expect(result.ok && result.finalUrl).toBe("https://example.com/docs");
  });

  it("rejects non-http(s) and malformed urls as a value", async () => {
    await expect(fetchWebPage("ftp://example.com/x")).resolves.toMatchObject({ ok: false, code: "bad-url" });
    await expect(fetchWebPage("not a url")).resolves.toMatchObject({ ok: false, code: "bad-url" });
  });

  it("reports http errors without a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(fetchWebPage("https://example.com/nope")).resolves.toMatchObject({
      ok: false,
      code: "http-error",
    });
  });

  it("rejects binary content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("\x89PNG", { status: 200, headers: { "content-type": "image/png" } })),
    );
    await expect(fetchWebPage("https://example.com/img.png")).resolves.toMatchObject({
      ok: false,
      code: "unsupported-content-type",
    });
  });

  it("truncates the download at the byte cap", async () => {
    const chunk = "x".repeat(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 12; i += 1) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const result = await fetchWebPage("https://example.com/big.txt");
    expect(result).toMatchObject({ ok: true, truncated: true, contentType: "text/plain" });
    expect(result.ok && result.bytes).toBe(2 * 1024 * 1024);
    expect(result.ok && result.text.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("clips the returned text at the context cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("y".repeat(70_000), { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const result = await fetchWebPage("https://example.com/long.txt");
    expect(result).toMatchObject({ ok: true, textClipped: true });
    expect(result.ok && result.text.startsWith("[clipped") !== true).toBe(true);
  });

  it("wraps network failures as a value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(fetchWebPage("https://down.example.com")).resolves.toMatchObject({
      ok: false,
      code: "network",
    });
  });
});

/** Replays the recorded live shape: SSE body, mcp-session-id, double-encoded hits. */
function sseResponse(payload: unknown, sessionId?: string): Response {
  const body = `event:message\ndata:${JSON.stringify(payload)}\n\n`;
  const headers: Record<string, string> = { "content-type": "text/event-stream;charset=UTF-8" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return new Response(body, { status: 200, headers });
}

const HITS = [
  { title: "AI SDK 7 is now available", link: "https://vercel.com/blog/ai-sdk-7", content: "WorkflowAgent and more.", refer: "ref_1" },
  { title: "Migration guide", link: "https://ai-sdk.dev/migrate", content: "How to upgrade.", refer: "ref_2" },
];

const HITS_TEXT = JSON.stringify(JSON.stringify(HITS));

describe("searchWeb", () => {
  const hadKey = process.env.ZAI_API_KEY;

  afterEach(() => {
    if (hadKey) process.env.ZAI_API_KEY = hadKey;
    else delete process.env.ZAI_API_KEY;
  });

  it("is not-configured without a Z.AI key", async () => {
    delete process.env.ZAI_API_KEY;
    await expect(searchWeb("anything")).resolves.toMatchObject({ ok: false, code: "not-configured" });
  });

  it("parses the double-encoded SSE payload into hits", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }, "sess-1");
      expect(init?.headers).toMatchObject({ "mcp-session-id": "sess-1" });
      expect(body.method).toBe("tools/call");
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      expect(params.name).toBe("web_search_prime");
      expect(params.arguments.search_query).toBe("ai sdk");
      return sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: HITS_TEXT }], isError: false },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("ai sdk");
    expect(result).toMatchObject({ ok: true, query: "ai sdk" });
    expect(result.ok && result.results).toEqual([
      { title: "AI SDK 7 is now available", url: "https://vercel.com/blog/ai-sdk-7", snippet: "WorkflowAgent and more." },
      { title: "Migration guide", url: "https://ai-sdk.dev/migrate", snippet: "How to upgrade." },
    ]);
  });

  it("passes recency and domain filters through, dropping the noLimit default", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: {} }, "sess-1");
      const args = body.params!.arguments!;
      if (args.search_query === "fresh") {
        expect(args).toMatchObject({ search_recency_filter: "oneWeek", search_domain_filter: "docs.example.com" });
      } else {
        expect(args.search_recency_filter).toBeUndefined();
        expect(args.location).toBe("us");
      }
      return sseResponse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: HITS_TEXT }] } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await searchWeb("plain");
    await searchWeb("fresh", { recency: "oneWeek", domain: "docs.example.com" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("caps results and snippet length", async () => {
    process.env.ZAI_API_KEY = "test-key";
    const many = Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`,
      link: `https://example.com/${i}`,
      content: "z".repeat(800),
    }));
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: {} }, "s");
      return sseResponse({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify(JSON.stringify(many)) }] },
      });
    }));
    const result = await searchWeb("many");
    expect(result.ok && result.results.length).toBe(8);
    const snippet = result.ok ? result.results[0]!.snippet : "";
    // clipHead keeps the first 500 chars, then a "… [N chars clipped]" marker.
    expect(snippet.startsWith("z".repeat(500))).toBe(true);
    expect(snippet).toContain("chars clipped");
  });

  it("surfaces JSON-RPC errors and tool-level isError as values", async () => {
    process.env.ZAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: {} }, "s");
      return sseResponse({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "quota exhausted" } });
    }));
    await expect(searchWeb("q")).resolves.toMatchObject({ ok: false, code: "mcp-error", message: expect.stringContaining("quota") });
  });

  it("rejects unparseable payloads as bad-response", async () => {
    process.env.ZAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (body.method === "initialize") return sseResponse({ jsonrpc: "2.0", id: 1, result: {} }, "s");
      return sseResponse({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "not json {" }] } });
    }));
    await expect(searchWeb("q")).resolves.toMatchObject({ ok: false, code: "bad-response" });
  });
});
