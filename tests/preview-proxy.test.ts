import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPreviewProxy, type Resolution } from "../lib/previews/proxy";

/**
 * 0016: the hand-rolled node:http proxy against a real local upstream —
 * Host routing, header forwarding, streaming, the fallback pages, and a
 * raw WebSocket-style upgrade spliced both ways (what HMR needs).
 */

let upstream: http.Server;
let proxy: http.Server;
let upstreamPort = 0;
let proxyPort = 0;
const requests: string[] = [];
const upgraded: import("node:stream").Duplex[] = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    requests.push(String(req.headers["x-forwarded-host"]));
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 20);
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(`echo:${body}`));
      return;
    }
    res.setHeader("x-upstream", "yes");
    res.end(`host=${req.headers.host} fwd=${req.headers["x-forwarded-host"]} path=${req.url}`);
  });
  upstream.on("upgrade", (req, socket) => {
    upgraded.push(socket);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (d) => socket.write(`pong:${d.toString()}`));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const resolve = (slug: string): Resolution =>
    slug === "live-ab12"
      ? { kind: "ok", previewId: "pv_live", host: "127.0.0.1", port: upstreamPort }
      : slug === "down-ab12"
        ? { kind: "down", previewId: "pv_down", status: "crashed", label: "feat/x" }
        : { kind: "missing" };
  const stamped: string[] = [];
  proxy = createPreviewProxy({ resolve, onRequest: (id) => stamped.push(id), appOrigin: "http://sweatshop.test" });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  proxyPort = (proxy.address() as AddressInfo).port;
});

afterAll(async () => {
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  for (const s of upgraded) s.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => upstream.close(r));
});

function get(host: string, path = "/", method = "GET", body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path, method, headers: { host } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("0016 preview proxy", () => {
  it("routes by Host and forwards the public host", async () => {
    const res = await get("pv-live-ab12.internal.crussell.io", "/a/b?c=1");
    expect(res.status).toBe(200);
    expect(res.headers["x-upstream"]).toBe("yes");
    expect(res.text).toBe("host=pv-live-ab12.internal.crussell.io fwd=pv-live-ab12.internal.crussell.io path=/a/b?c=1");
  });

  it("streams responses and passes request bodies", async () => {
    const stream = await get("pv-live-ab12.internal.crussell.io", "/stream");
    expect(stream.text).toBe("data: one\n\ndata: two\n\n");
    const post = await get("pv-live-ab12.internal.crussell.io", "/p", "POST", "hello");
    expect(post.text).toBe("echo:hello");
  });

  it("answers down and unknown previews with a fallback page", async () => {
    const down = await get("pv-down-ab12.internal.crussell.io");
    expect(down.status).toBe(503);
    expect(down.text).toContain("is crashed");
    expect(down.text).toContain("http://sweatshop.test/previews?id=pv_down");
    const missing = await get("pv-gone-ab12.internal.crussell.io");
    expect(missing.status).toBe(404);
    const notPreview = await get("artifacts.internal.crussell.io");
    expect(notPreview.status).toBe(404);
  });

  it("splices upgrades both ways (HMR websockets)", async () => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    const received: string[] = [];
    socket.on("data", (d) => received.push(d.toString()));
    await new Promise<void>((r) => socket.once("connect", () => r()));
    socket.write(
      "GET /_hmr HTTP/1.1\r\nHost: pv-live-ab12.internal.crussell.io\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    await expect.poll(() => received.join("")).toContain("101 Switching Protocols");
    socket.write("ping");
    await expect.poll(() => received.join("")).toContain("pong:ping");
    socket.destroy();
  });

  it("returns 502 when the upstream is unreachable", async () => {
    upstream.closeAllConnections();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const deadProxy = createPreviewProxy({
      resolve: () => ({ kind: "ok", previewId: "pv_dead", host: "127.0.0.1", port: deadPort }),
    });
    await new Promise<void>((r) => deadProxy.listen(0, "127.0.0.1", r));
    const port = (deadProxy.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve) => {
      http.get({ host: "127.0.0.1", port, headers: { host: "pv-x-ab12.a.b" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
    });
    expect(status).toBe(502);
    await new Promise((r) => deadProxy.close(r));
  });
});
