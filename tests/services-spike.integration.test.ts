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
});
