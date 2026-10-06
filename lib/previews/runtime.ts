import type { Server } from "node:http";
import { db } from "@/db";
import { expireStaleProvisioning, getPreviewBySlug, previewSandbox, stampRequest } from "@/db/previews";
import { harnessPreviewNetwork, type PreviewNetwork } from "@/lib/previews/network";
import { createPreviewProxy, type Resolution } from "@/lib/previews/proxy";
import { followBranchPreviews } from "@/lib/previews/follow";
import { reconcilePreviews } from "@/lib/previews/service";

/**
 * 0016: the in-process preview runtime, started once from
 * instrumentation.ts — the proxy listener and the tick. The tick
 * reconciles every preview and (phase 3) advances branch previews.
 */

const STAMP_EVERY_MS = 60_000;
/** Cached Host lookups — a page load fans out into dozens of requests. */
const RESOLVE_TTL_MS = 2_000;

export function makeResolver(network: PreviewNetwork = harnessPreviewNetwork) {
  const cache = new Map<string, { at: number; value: Resolution }>();
  return (slug: string): Resolution => {
    const hit = cache.get(slug);
    const now = Date.now();
    if (hit && now - hit.at < RESOLVE_TTL_MS) return hit.value;
    const value = resolveSlug(slug, network);
    cache.set(slug, { at: now, value });
    return value;
  };
}

function resolveSlug(slug: string, network: PreviewNetwork): Resolution {
  const p = getPreviewBySlug(db(), slug);
  if (!p) return { kind: "missing" };
  const sbx = previewSandbox(db(), p.sandboxId);
  // A preview still booting is proxied anyway: the dev server may answer
  // before the tick marks it healthy, and an upstream error is honest. A
  // `failed` branch preview keeps serving its last good commit (the
  // follower never killed it), so it is proxied too.
  if (sbx?.status !== "running" || !["starting", "healthy", "failed"].includes(p.status)) {
    return { kind: "down", previewId: p.id, status: p.status, label: p.label ?? p.branch };
  }
  const target = network.target(sbx.ref, p.port);
  return { kind: "ok", previewId: p.id, host: target.host, port: target.port };
}

export function makeStamper() {
  const last = new Map<string, number>();
  return (previewId: string): void => {
    const now = Date.now();
    if (now - (last.get(previewId) ?? 0) < STAMP_EVERY_MS) return;
    last.set(previewId, now);
    try {
      stampRequest(db(), previewId, now);
    } catch (err) {
      console.error("[previews] could not stamp request", err);
    }
  };
}

export function startPreviewProxy(port: number, appOrigin?: string): Server {
  const server = createPreviewProxy({
    resolve: makeResolver(),
    onRequest: makeStamper(),
    ...(appOrigin ? { appOrigin } : {}),
  });
  server.on("error", (err) => console.error("[previews] proxy error", err));
  server.listen(port, "0.0.0.0", () => console.log(`[previews] proxy on :${port}`));
  return server;
}

let ticking = false;

/** One tick: reconcile every preview, then follow branch previews.
 *  Never overlaps itself (a slow install just delays the next tick). */
export async function previewTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // 0017: provisioning rows that never got confirmed (an abandoned
    // create) age out visibly instead of sitting forever.
    const expired = expireStaleProvisioning(db());
    if (expired.length) console.log(`[previews] provisioning timed out: ${expired.join(", ")}`);
    const report = await reconcilePreviews();
    if (report.changed.length > 0 || report.errors.length > 0) {
      console.log(
        `[previews] ${report.changed.join(", ") || "no changes"}` +
          (report.errors.length ? `; errors: ${report.errors.join("; ")}` : ""),
      );
    }
    for (const r of await followBranchPreviews()) {
      if (r.action === "unchanged" || (r.action === "skipped" && !r.detail?.startsWith("fetch"))) continue;
      console.log(`[previews] follow ${r.previewId}: ${r.action}${r.sha ? ` ${r.sha.slice(0, 7)}` : ""}${r.detail ? ` — ${r.detail.split("\n")[0]}` : ""}`);
    }
  } catch (err) {
    console.error("[previews] tick failed", err);
  } finally {
    ticking = false;
  }
}
