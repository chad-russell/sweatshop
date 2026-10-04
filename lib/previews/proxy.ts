import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { slugFromHost } from "@/lib/previews/network";

/**
 * 0016: the preview proxy — a plain node:http listener (no dependency;
 * Chad's call, revisit only if it shows problems). Routes by Host:
 * `pv-<slug>.<base>` → the preview's sandbox container on the harness
 * network. HTTP requests are piped through `http.request`; WebSocket
 * (and any other) upgrades are spliced at the TCP level so HMR works.
 * It is NOT a Next route: route handlers cannot proxy upgrades.
 *
 * Resolution is a seam (`resolve`) so tests run the proxy against a
 * local upstream with no sqlite or podman.
 */

export type Resolution =
  | { kind: "ok"; previewId: string; host: string; port: number }
  | { kind: "missing" }
  | { kind: "down"; previewId: string; status: string; label: string | null };

export interface ProxyOptions {
  resolve(slug: string): Resolution;
  /** Called on every proxied request (the caller throttles stamping). */
  onRequest?(previewId: string): void;
  /** Where "open in sweatshop" links on the fallback page point. */
  appOrigin?: string;
}

/** Hop-by-hop headers (RFC 9110 §7.6.1) never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  // The app sees its public host (it lives at a root on its own host);
  // the X-Forwarded-* trio tells it the scheme Caddy terminated.
  const remote = req.socket.remoteAddress ?? "";
  const prior = req.headers["x-forwarded-for"];
  out["x-forwarded-for"] = prior ? `${String(prior)}, ${remote}` : remote;
  out["x-forwarded-host"] = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
  out["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "http";
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The small page a stopped or unknown preview answers with. */
export function fallbackPage(resolution: Exclude<Resolution, { kind: "ok" }>, appOrigin?: string): string {
  const title =
    resolution.kind === "missing" ? "No such preview" : `Preview ${escapeHtml(resolution.label ?? "")} is ${escapeHtml(resolution.status)}`;
  const detail =
    resolution.kind === "missing"
      ? "This preview was deleted, or never existed."
      : "Its server is not running right now. Start it again from sweatshop.";
  const link = appOrigin
    ? `<p><a href="${escapeHtml(`${appOrigin}/previews${resolution.kind === "down" ? `?id=${resolution.previewId}` : ""}`)}">Open in sweatshop</a></p>`
    : "";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#333}h1{font-size:1.2rem}</style><h1>${title}</h1><p>${detail}</p>${link}`;
}

function sendFallback(res: ServerResponse, resolution: Exclude<Resolution, { kind: "ok" }>, appOrigin?: string): void {
  res.writeHead(resolution.kind === "missing" ? 404 : 503, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(fallbackPage(resolution, appOrigin));
}

function badGateway(res: ServerResponse, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
  res.end(`preview upstream error: ${message}\n`);
}

function resolveRequest(req: IncomingMessage, options: ProxyOptions): Resolution {
  const slug = slugFromHost(req.headers.host);
  return slug ? options.resolve(slug) : { kind: "missing" };
}

export function handleRequest(options: ProxyOptions) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const target = resolveRequest(req, options);
    if (target.kind !== "ok") {
      sendFallback(res, target, options.appOrigin);
      return;
    }
    options.onRequest?.(target.previewId);
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req),
      },
      (upstreamRes) => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
        // Stream through (SSE, chunked responses): no buffering.
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => badGateway(res, err.message));
    // A client that goes away tears the upstream request down too.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  };
}

/**
 * Upgrade (WebSocket): open a raw TCP connection to the upstream, replay
 * the request head verbatim (including Upgrade/Connection — those ARE
 * the request here), then splice the two sockets both ways.
 */
export function handleUpgrade(options: ProxyOptions, track?: (s: Duplex) => void) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    track?.(socket);
    const target = resolveRequest(req, options);
    if (target.kind !== "ok") {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return;
    }
    options.onRequest?.(target.previewId);
    const upstream = net.connect(target.port, target.host);
    track?.(upstream);
    const fail = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.once("error", () => {
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      fail();
    });
    socket.once("error", fail);
    upstream.once("connect", () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  };
}

export function createPreviewProxy(options: ProxyOptions): Server {
  const server = http.createServer(handleRequest(options));
  // Upgraded sockets leave the http server's bookkeeping, so
  // closeAllConnections() cannot see them: track them here, or a close
  // waits forever on an open HMR socket.
  const spliced = new Set<Duplex>();
  const track = (s: Duplex) => {
    spliced.add(s);
    s.once("close", () => spliced.delete(s));
  };
  server.on("upgrade", handleUpgrade(options, track));
  server.on("close", () => {
    for (const s of spliced) s.destroy();
  });
  const closeAll = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => {
    closeAll();
    for (const s of spliced) s.destroy();
  };
  // Dev servers hold long-lived connections (HMR, SSE); no idle cutoff.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
