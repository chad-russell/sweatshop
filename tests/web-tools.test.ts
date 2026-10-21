import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWebPage, htmlToText } from "../lib/agent/tools/web";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchProviderOrder, searchWeb } from "../lib/agent/tools/web-search";
import { hitsFromStream } from "../lib/agent/tools/search-providers/codex";

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

const SEARCH_ENV = [
  "ZAI_API_KEY",
  "TAVILY_API_KEY",
  "ANTHROPIC_SEARCH_API_KEY",
  "WEB_SEARCH_PROVIDERS",
  "HARNESS_AUTH_DIR",
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A valid-shaped ChatGPT login in a throwaway auth dir (far-future expiry). */
function plantCodexLogin(): void {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-auth-"));
  mkdirSync(path.join(dir, "codex"));
  const exp = Math.floor(Date.now() / 1000) + 86_400;
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  writeFileSync(
    path.join(dir, "codex", "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt, refresh_token: "r", account_id: "acct-1" } }),
  );
  process.env.HARNESS_AUTH_DIR = dir;
}

describe("searchWeb", () => {
  const saved = Object.fromEntries(SEARCH_ENV.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    // No real login or key may leak into the gate: every provider starts unconfigured.
    for (const name of SEARCH_ENV) delete process.env[name];
    process.env.HARNESS_AUTH_DIR = mkdtempSync(path.join(tmpdir(), "no-auth-"));
  });

  afterEach(() => {
    for (const name of SEARCH_ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
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
  it("reports which provider answered", async () => {
    process.env.TAVILY_API_KEY = "t";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: [{ title: "T", url: "https://a.example", content: "c" }] })));
    await expect(searchWeb("q")).resolves.toMatchObject({ ok: true, provider: "tavily" });
  });

  it("falls through to Tavily when Z.AI is not configured", async () => {
    process.env.TAVILY_API_KEY = "tav";
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer tav" });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: "q",
        time_range: "week",
        include_domains: ["docs.example.com"],
      });
      return jsonResponse({ results: [{ title: "T", url: "https://a.example", content: "snippet" }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("q", { recency: "oneWeek", domain: "docs.example.com" });
    expect(result).toMatchObject({ ok: true, provider: "tavily" });
    expect(result.ok && result.results).toEqual([{ title: "T", url: "https://a.example", snippet: "snippet" }]);
  });

  it("falls through when Z.AI is configured but fails, and keeps its error if all fail", async () => {
    process.env.ZAI_API_KEY = "z";
    process.env.TAVILY_API_KEY = "tav";
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("z.ai")) throw new Error("zai down");
      return jsonResponse({ results: [{ title: "T", url: "https://a.example", content: "c" }] });
    }));
    await expect(searchWeb("q")).resolves.toMatchObject({ ok: true, provider: "tavily" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("everything down");
    }));
    const failed = await searchWeb("q");
    expect(failed).toMatchObject({ ok: false, code: "network" });
    expect(!failed.ok && failed.message).toContain("zai:");
    expect(!failed.ok && failed.message).toContain("tavily:");
  });

  it("asks Codex with the stored login and cites sources as hits", async () => {
    plantCodexLogin();
    const text = "Vitest 4 shipped in October.";
    const sse = [
      { type: "response.created" },
      {
        type: "response.output_item.done",
        item: {
          type: "message",
          content: [
            {
              type: "output_text",
              text,
              annotations: [
                { type: "url_citation", url: "https://vitest.dev/blog", title: "Vitest blog", start_index: 0, end_index: 30 },
                { type: "url_citation", url: "https://vitest.dev/blog", title: "dupe", start_index: 0, end_index: 30 },
              ],
            },
          ],
        },
      },
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join("");
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "chatgpt-account-id": "acct-1" });
      const body = JSON.parse(String(init?.body)) as { tools: unknown; stream: boolean; input: { content: { text: string }[] }[] };
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.stream).toBe(true);
      expect(body.input[0]!.content[0]!.text).toBe("vitest site:vitest.dev");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await searchWeb("vitest", { domain: "vitest.dev" });
    expect(result).toMatchObject({ ok: true, provider: "codex" });
    expect(result.ok && result.results).toEqual([
      { title: "Vitest blog", url: "https://vitest.dev/blog", snippet: "" },
    ]);
  });

  it("reads Claude's search-result blocks, with citations as snippets", async () => {
    process.env.ANTHROPIC_SEARCH_API_KEY = "ak";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "x-api-key": "ak" });
      return jsonResponse({
        content: [
          { type: "server_tool_use", name: "web_search" },
          {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://a.example", title: "A" },
              { type: "web_search_result", url: "https://b.example", title: "B" },
            ],
          },
          { type: "text", text: "x", citations: [{ url: "https://a.example", cited_text: "quoted A" }] },
        ],
      });
    }));
    const result = await searchWeb("q");
    expect(result).toMatchObject({ ok: true, provider: "claude" });
    expect(result.ok && result.results).toEqual([
      { title: "A", url: "https://a.example", snippet: "quoted A" },
      { title: "B", url: "https://b.example", snippet: "" },
    ]);
  });

  it("orders providers zai → codex → claude → tavily, overridable by env", () => {
    expect(searchProviderOrder({})).toEqual(["zai", "codex", "claude", "tavily"]);
    expect(searchProviderOrder({ WEB_SEARCH_PROVIDERS: "tavily, zai, bogus, tavily" })).toEqual(["tavily", "zai"]);
    expect(searchProviderOrder({ WEB_SEARCH_PROVIDERS: "bogus" })).toEqual(["zai", "codex", "claude", "tavily"]);
  });

  it("is not-configured naming every option when nothing is set", async () => {
    const result = await searchWeb("q");
    expect(result).toMatchObject({ ok: false, code: "not-configured" });
    expect(!result.ok && result.message).toMatch(/ZAI_API_KEY.*codex.*ANTHROPIC_SEARCH_API_KEY.*TAVILY_API_KEY/);
  });
});

describe("hitsFromStream", () => {
  it("takes the sentence a citation ends as its snippet", () => {
    const text = "First line.\nVitest 4 shipped.";
    const sse = `data: ${JSON.stringify({
      type: "response.output_item.done",
      item: {
        type: "message",
        content: [
          {
            type: "output_text",
            text: text + " [1]",
            annotations: [{ type: "url_citation", url: "https://x.example", title: "X", start_index: text.length + 1 }],
          },
        ],
      },
    })}\n\n`;
    expect(hitsFromStream(sse)).toEqual([{ title: "X", url: "https://x.example", snippet: "Vitest 4 shipped." }]);
  });

  it("ignores malformed lines and non-message items", () => {
    expect(hitsFromStream('data: not json\n\ndata: {"type":"response.output_item.done","item":{"type":"web_search_call"}}\n')).toEqual([]);
  });
});
