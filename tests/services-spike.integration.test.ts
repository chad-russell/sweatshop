import { describe, expect, it } from "vitest";

/**
 * 0017 phase 3 opt-in integration test (the claude-spike pattern): a
 * REAL service container next to a real sandbox, dialable from inside
 * the sandbox by its provider-resolved name, dying with the sandbox.
 * Needs podman — run with:
 *   SERVICES_SPIKE=1 npx vitest run tests/services-spike.integration.test.ts
 */

const enabled = process.env.SERVICES_SPIKE === "1";
const d = enabled ? describe : describe.skip;

d("0017 services substrate (live)", () => {
  it("a declared service answers inside the sandbox and dies with it", async () => {
    const { ensureSandboxServices, destroySandboxServices, serviceAddress } = await import(
      "../lib/sandboxes/services"
    );
    const { podmanProvider } = await import("../lib/sandboxes/provider");
    const { insertLease, getLease } = await import("../db/sandboxes");
    const { db } = await import("../db");
    const { markDestroyed, updateLease } = await import("../db/sandboxes");

    const lease = insertLease(db(), {
      provider: "podman",
      ownerKind: "preview",
      ownerId: `spike_${Date.now()}`,
      projectId: null,
    });
    const handle = await podmanProvider.create({ namePrefix: lease.ownerId, projectId: null });
    updateLease(db(), lease.id, { ref: handle.ref, status: "running" });
    // A real launch joins the sandbox to the harness network (the preview
    // service's openPreviewSandbox does) — without it the sandbox cannot
    // resolve the service's container name.
    const { connectContainerToHarnessNetwork } = await import("../lib/sandboxes/harness-bridge");
    await connectContainerToHarnessNetwork(handle.ref);

    try {
      // The service: the sandbox image running a one-line HTTP server.
      await ensureSandboxServices(lease.id, [
        {
          name: "echo",
          image: "localhost/sweatshop-sandbox",
          command: "node -e 'require(\"http\").createServer((q,s)=>s.end(\"ok\")).listen(8787)'",
          env: {},
          port: 8787,
        },
      ]);
      const address = serviceAddress(lease.id, "echo");
      expect("error" in address).toBe(false);
      if ("error" in address) throw new Error(address.error);
      const probe = await handle.run(
        `timeout 2 bash -c '</dev/tcp/${address.address}/8787' >/dev/null 2>&1 && echo ready`,
      );
      expect(probe.stdout.trim()).toBe("ready");
    } finally {
      await destroySandboxServices(lease.id);
      await podmanProvider.destroy(handle.ref);
      markDestroyed(db(), lease.id);
      expect(getLease(db(), lease.id)?.status).toBe("destroyed");
    }
  }, 120_000);

  it("0019: stopping keeps the container and its state; ensure starts the SAME container again", async () => {
    const { ensureSandboxServices, stopSandboxServices, destroySandboxServices, serviceAddress } = await import(
      "../lib/sandboxes/services"
    );
    const { podmanProvider } = await import("../lib/sandboxes/provider");
    const { insertLease, markDestroyed, updateLease } = await import("../db/sandboxes");
    const { db } = await import("../db");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const docker = async (...args: string[]) => (await promisify(execFile)("docker", args)).stdout.trim();

    const lease = insertLease(db(), {
      provider: "podman",
      ownerKind: "preview",
      ownerId: `spike_stop_${Date.now()}`,
      projectId: null,
    });
    const handle = await podmanProvider.create({ namePrefix: lease.ownerId, projectId: null });
    updateLease(db(), lease.id, { ref: handle.ref, status: "running" });
    // A service with state: it writes a marker into its own writable layer at boot.
    const spec = {
      name: "keeper",
      image: "localhost/sweatshop-sandbox",
      command: "bash -c 'test -f /tmp/marker || echo first-boot > /tmp/marker; exec node -e \"require(\\\"http\\\").createServer((q,s)=>s.end(\\\"ok\\\")).listen(8787)\"'",
      env: {},
      port: 8787,
    };
    const name = `${handle.ref}-svc-keeper`;
    try {
      await ensureSandboxServices(lease.id, [spec]);
      const idBefore = await docker("inspect", "-f", "{{.Id}}", name);

      await stopSandboxServices(lease.id);
      expect(await docker("inspect", "-f", "{{.State.Running}}", name)).toBe("false");
      expect(await docker("inspect", "-f", "{{.Id}}", name)).toBe(idBefore); // kept, not removed

      await ensureSandboxServices(lease.id, [spec]);
      expect(await docker("inspect", "-f", "{{.State.Running}}", name)).toBe("true");
      expect(await docker("inspect", "-f", "{{.Id}}", name)).toBe(idBefore); // the same container
      expect(await docker("exec", name, "cat", "/tmp/marker")).toBe("first-boot"); // its state survived
      expect("error" in serviceAddress(lease.id, "keeper")).toBe(false);
    } finally {
      await destroySandboxServices(lease.id);
      await podmanProvider.destroy(handle.ref);
      markDestroyed(db(), lease.id);
    }
  }, 120_000);
});

