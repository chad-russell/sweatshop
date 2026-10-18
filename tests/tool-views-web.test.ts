import { describe, expect, it } from "vitest";
import {
  fetchView,
  formatBytes,
  searchView,
  urlHeadline,
  webFailureOf,
  webState,
} from "../lib/tool-views/web";

/** 1.5: the web cards' normalisers — pure and defensive, never trusting
 * stored input/output to have every field (tool-views/inspect posture). */

describe("webFailureOf", () => {
  it("reads the value-shaped failure and nothing else", () => {
    expect(webFailureOf({ ok: false, code: "http-error", message: "HTTP 404" })).toEqual({
      code: "http-error",
      message: "HTTP 404",
    });
    expect(webFailureOf({ ok: true })).toBeUndefined();
    expect(webFailureOf(undefined)).toBeUndefined();
    expect(webFailureOf("clipped string")).toBeUndefined();
    expect(webFailureOf({ ok: false })).toEqual({ code: "error", message: "the tool reported a failure" });
  });
});

describe("webState", () => {
  it("maps part states through failure", () => {
    expect(webState({ state: "output-available" }, false)).toBe("completed");
    expect(webState({ state: "input-available" }, false)).toBe("running");
    expect(webState({ state: "output-available" }, true)).toBe("error");
    expect(webState({ state: "output-error" }, false)).toBe("error");
    expect(webState({ state: "output-denied" }, false)).toBe("error");
  });
});

describe("searchView", () => {
  it("reads query and shaped hits", () => {
    const view = searchView(
      { query: "ai sdk" },
      { ok: true, results: [{ title: "AI SDK", url: "https://ai-sdk.dev", snippet: "The SDK." }] },
    );
    expect(view).toEqual({ query: "ai sdk", hits: [{ title: "AI SDK", url: "https://ai-sdk.dev", snippet: "The SDK." }] });
  });

  it("keeps the query while running (no output yet) and caps the list", () => {
    expect(searchView({ query: "q" }, undefined)).toEqual({ query: "q", hits: [] });
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, url: `u${i}` }));
    expect(searchView({ query: "q" }, { results: many })!.hits.length).toBe(12);
  });

  it("skips hits without anything to show and survives junk", () => {
    const view = searchView({ query: "q" }, { results: [{ snippet: "only" }, null, { title: "T", url: "u" }] });
    expect(view!.hits).toEqual([{ title: "T", url: "u", snippet: "" }]);
    expect(searchView(undefined, { results: [] })).toBeUndefined();
    expect(searchView({ query: "q" }, "clipped")).toEqual({ query: "q", hits: [] });
  });
});

describe("fetchView", () => {
  it("reads the fetched-page shape", () => {
    const view = fetchView(
      { url: "https://example.com/a" },
      { ok: true, url: "https://example.com/a", finalUrl: "https://example.com/b", status: 200, contentType: "text/html", bytes: 4096, title: "T", text: "body", truncated: true },
    );
    expect(view).toEqual({
      url: "https://example.com/a",
      finalUrl: "https://example.com/b",
      status: 200,
      contentType: "text/html",
      bytes: 4096,
      title: "T",
      text: "body",
      truncated: true,
      textClipped: false,
    });
  });

  it("needs a string url from the input, tolerates missing output", () => {
    expect(fetchView({ url: "u" }, undefined)).toMatchObject({ url: "u" });
    expect(fetchView(undefined, { ok: true })).toBeUndefined();
    expect(fetchView({ url: 7 }, { ok: true })).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats bytes at both scales", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2477)).toBe("2.4 kB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("headlines host + path and falls back to the raw string", () => {
    expect(urlHeadline("https://example.com/docs/page?x=1")).toBe("example.com/docs/page");
    expect(urlHeadline("https://example.com")).toBe("example.com");
    expect(urlHeadline("not a url")).toBe("not a url");
  });
});
