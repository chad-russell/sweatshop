/**
 * 1.5 (roadmap): the web_fetch core — plain HTTP with a download cap,
 * HTML stripped to readable text. Results are value-shaped (0015 style)
 * so the model reads a failure and repairs its call. Everything that
 * comes back from the web is UNTRUSTED data: the tool description and
 * the turn instructions both say so, and nothing here ever executes or
 * interprets it.
 */

import { clipHead } from "@/lib/clip";

export type WebResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Download cap: read at most this many bytes of the body. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Context cap: the model sees at most this many characters of text. */
const MAX_TEXT_CHARS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;

const TEXTUAL_CONTENT = /^(text\/|application\/(json|xml|x-html\+xml|atom|rdf|rss|x-yaml|yaml))/;

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  title?: string;
  text: string;
  /** The download hit the byte cap. */
  truncated: boolean;
  /** The text was clipped to the context cap. */
  textClipped: boolean;
}

export async function fetchWebPage(rawUrl: string): Promise<WebResult<FetchedPage>> {
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
  } catch {
    return { ok: false, code: "bad-url", message: `Not an absolute http(s) URL: ${rawUrl}` };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain,application/json,text/markdown,*/*;q=0.5",
        "user-agent": "sweatshop-agent/1.0",
      },
    });
  } catch (err) {
    return {
      ok: false,
      code: "network",
      message: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      code: "http-error",
      message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""} for ${url}`,
    };
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  const kind = contentType || "unknown";
  if (kind !== "unknown" && !TEXTUAL_CONTENT.test(kind)) {
    return {
      ok: false,
      code: "unsupported-content-type",
      message: `Content type ${kind} cannot be returned as text; fetch text/html, text/plain, JSON or XML only`,
    };
  }

  const { body, bytes, truncated } = await readCapped(response);
  const isHtml = kind === "text/html" || kind === "application/xhtml+xml";
  const extracted = isHtml ? htmlToText(body) : { title: undefined, text: body };
  const text = clipHead(extracted.text, MAX_TEXT_CHARS);
  const clipped = text !== extracted.text;

  return {
    ok: true,
    url: rawUrl,
    finalUrl: response.url || url.href,
    status: response.status,
    contentType: kind,
    bytes,
    ...(extracted.title ? { title: extracted.title } : {}),
    text,
    truncated,
    textClipped: clipped,
  };
}

/** Read the body up to MAX_BYTES; past the cap the rest is dropped. */
async function readCapped(response: Response): Promise<{ body: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: await response.text(), bytes: 0, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let body = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > MAX_BYTES) {
      const keep = Math.max(0, MAX_BYTES - bytes);
      body += decoder.decode(value.subarray(0, keep), { stream: true });
      bytes += keep;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    bytes += value.byteLength;
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return { body, bytes, truncated };
}

/**
 * HTML to readable text: keep the title, drop comments and the
 * script/style/noscript/template/svg/head blocks, break on block-level
 * tags, strip the rest, decode the common entities. Deliberately
 * regex-based — a personal tool fetching pages for an LLM does not need
 * a DOM.
 */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, " ").trim() : undefined;

  const s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|tr|table|tbody|thead|h[1-6]|pre|blockquote|section|article|aside|header|footer|nav|dl|dt|dd|form|fieldset|hr|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const text = decodeEntities(s)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { ...(title ? { title } : {}), text };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function safeCodePoint(code: number): string {
  return Number.isNaN(code) ? "" : String.fromCodePoint(code);
}
