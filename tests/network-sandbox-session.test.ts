import { describe, expect, it } from "vitest";
import { toNetworkSandboxSession } from "../lib/sandboxes/ai-sdk-adapter";

/**
 * 0013 Phase 1 — the full harness network sandbox session over a fake
 * handle: the bridge address resolves lazily (pi never asks), once per
 * session, a failed resolve is retried, and lifecycle is never a
 * harness's to touch.
 */

function fakeHandle() {
  const ran: string[] = [];
  return {
    ran,
    handle: {
      ref: "sbx-ref",
      async run(command: string) {
        ran.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
  };
}

describe("toNetworkSandboxSession (0013)", () => {
  it("exposes identity, work dir, and every bridge kind's port (0038 amendment)", () => {
    const { handle } = fakeHandle();
    const session = toNetworkSandboxSession({
      id: "sbx_1",
      handle,
      workDir: "/work/c1",
      resolveAddress: async () => "10.0.0.2",
    });
    expect(session.id).toBe("sbx_1");
    expect(session.defaultWorkingDirectory).toBe("/work/c1");
    // Every bridge-backed kind gets its own port — claimed concurrently,
    // their bridges must never share one (claude/cursor 0038, codex 0050).
    expect(session.ports).toEqual([4000, 4001, 4002]);
  });

  it("accepts an explicit ports override", () => {
    const { handle } = fakeHandle();
    const session = toNetworkSandboxSession({
      id: "sbx_1",
      handle,
      workDir: "/work/c1",
      resolveAddress: async () => "10.0.0.2",
      ports: [9999],
    });
    expect(session.ports).toEqual([9999]);
  });

  it("resolves the endpoint lazily and only once per session", async () => {
    const { handle } = fakeHandle();
    const asked: string[] = [];
    const session = toNetworkSandboxSession({
      id: "sbx_1",
      handle,
      workDir: "/work/c1",
      resolveAddress: async (ref) => {
        asked.push(ref);
        return "10.0.0.2";
      },
    });
    expect(asked).toEqual([]);

    const ws = await session.getPortEndpoint({ port: 4000, protocol: "ws" });
    const http = await session.getPortEndpoint({ port: 4000 });
    const url = await session.getPortUrl({ port: 4000, protocol: "ws" });
    expect(ws).toEqual({ url: "ws://10.0.0.2:4000" });
    expect(http.url).toBe("http://10.0.0.2:4000");
    expect(url).toBe("ws://10.0.0.2:4000");
    expect(asked).toEqual(["sbx-ref"]);
  });

  it("does not cache a failed resolve", async () => {
    const { handle } = fakeHandle();
    let calls = 0;
    const session = toNetworkSandboxSession({
      id: "sbx_1",
      handle,
      workDir: "/work/c1",
      resolveAddress: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network not ready");
        return "10.0.0.3";
      },
    });
    await expect(session.getPortEndpoint({ port: 4000 })).rejects.toThrow("network not ready");
    await expect(session.getPortEndpoint({ port: 4000 })).resolves.toEqual({
      url: "http://10.0.0.3:4000",
    });
  });

  it("never touches lifecycle; restricted() is the basic session", async () => {
    const { handle, ran } = fakeHandle();
    const session = toNetworkSandboxSession({
      id: "sbx_1",
      handle,
      workDir: "/work/c1",
      resolveAddress: async () => "10.0.0.2",
    });
    await session.stop();
    await session.destroy();
    expect(ran).toEqual([]);

    const basic = session.restricted();
    expect("getPortEndpoint" in basic).toBe(false);
    expect("stop" in basic).toBe(false);
    await basic.run({ command: "true" });
    expect(ran).toEqual(["true"]);
  });
});
