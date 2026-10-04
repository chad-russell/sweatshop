import { connectContainerToHarnessNetwork } from "@/lib/sandboxes/harness-bridge";

/**
 * 0016: how the Next process reaches a preview. Sandboxes publish no
 * ports; the only route in is the private `sweatshop-harness` podman
 * network (0006), which the dev container is on and which resolves
 * containers by name. A sandbox serving previews is joined to it, and
 * both the proxy and the health probe dial `<container ref>:<port>`
 * there. A seam so tests swap in a scripted network.
 */
export interface PreviewNetwork {
  /** Make the sandbox reachable (idempotent). */
  connect(ref: string): Promise<void>;
  /** Where to dial the preview. */
  target(ref: string, port: number): { host: string; port: number };
  /** Does anything answer HTTP there? Any response counts — a 404 or a
   *  500 still means the server is up. */
  probe(ref: string, port: number): Promise<boolean>;
}

const PROBE_TIMEOUT_MS = 3_000;

export const harnessPreviewNetwork: PreviewNetwork = {
  async connect(ref) {
    await connectContainerToHarnessNetwork(ref);
  },
  target(ref, port) {
    return { host: ref, port };
  },
  async probe(ref, port) {
    try {
      await fetch(`http://${ref}:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      return false;
    }
  },
};

/** The public host suffix previews are served under. */
export function previewBaseDomain(): string {
  return process.env.PREVIEW_BASE_DOMAIN?.trim() || "internal.crussell.io";
}

/** `pv-<slug>.<base>` — flat under the existing wildcard cert (0016). */
export function previewHost(slug: string): string {
  return `pv-${slug}.${previewBaseDomain()}`;
}

export function previewUrl(slug: string): string {
  const scheme = process.env.PREVIEW_URL_SCHEME?.trim() || "https";
  return `${scheme}://${previewHost(slug)}`;
}

/** The slug a request's Host header names, or null if it is not a preview host. */
export function slugFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const label = host.toLowerCase().split(":")[0]?.split(".")[0] ?? "";
  const match = /^pv-([a-z0-9-]{1,60})$/.exec(label);
  return match?.[1] ?? null;
}
