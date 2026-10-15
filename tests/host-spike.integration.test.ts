import { describe, expect, it } from "vitest";
import type { HostExecRequest } from "../lib/hosts/transport";

/**
 * 0043 live spike — the real ssh2 transport against a real SSH server,
 * on the same path the tool uses (credential resolution from env,
 * TOFU pinning, bash -lc wrapping, timeout kill). Not part of the
 * normal gate:
 *
 *   HOST_SPIKE=1 HOST_SPIKE_HOST=10.10.0.12 HOST_SPIKE_USER=crussell \
 *   HOST_SPIKE_KEY=/path/to/id_ed25519 \
 *     npx vitest run tests/host-spike.integration.test.ts
 *
 * (Password auth: HOST_SPIKE_PASSWORD instead of the key. A second run
 * must reuse the pinned fingerprint from the first — TOFU proven live.)
 */
const run = process.env.HOST_SPIKE === "1" ? describe : describe.skip;

const ADDRESS = process.env.HOST_SPIKE_HOST ?? "";
const USER = process.env.HOST_SPIKE_USER ?? "crussell";
const KEY = process.env.HOST_SPIKE_KEY ?? "";
const PASSWORD = process.env.HOST_SPIKE_PASSWORD ?? "";

run("host channel spike (0043)", () => {
  it("execs over ssh2: wraps in bash -lc, captures output, pins TOFU, times out", async () => {
    expect(ADDRESS, "HOST_SPIKE_HOST is required").toBeTruthy();
    expect(KEY || PASSWORD, "HOST_SPIKE_KEY or HOST_SPIKE_PASSWORD is required").toBeTruthy();

    const { resolveHostCredential, credentialEnvNames } = await import("../lib/hosts/credentials");
    const { ssh2Transport } = await import("../lib/hosts/transport");

    // Stage the credential through the same env names the tool reads.
    const names = credentialEnvNames("spiketest");
    if (KEY) {
      process.env[names.keyFile] = KEY;
    } else {
      process.env[names.password] = PASSWORD;
    }
    const credential = resolveHostCredential("spiketest");
    expect(credential.ok).toBe(true);
    if (!credential.ok) throw new Error(credential.message);

    const transport = ssh2Transport;
    const base = {
      hostId: "ph_spike",
      host: ADDRESS,
      port: 22,
      username: USER,
      credential: credential.ok ? credential.credential : { kind: "password" as const, password: "" },
    };

    // 1. First connect pins a fingerprint; bash -lc semantics hold
    //    (login shell PATH + quoting round-trips).
    const first = await transport.exec({
      ...base,
      command: "printf '%s' \"$(echo ok from $(hostname))\"",
      timeoutMs: 30_000,
      expectedFingerprint: null,
    } satisfies HostExecRequest);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    expect(first.result.exitCode).toBe(0);
    expect(first.result.stdout).toContain("ok from");
    const fp = first.result.pinnedFingerprint;
    expect(fp).toMatch(/^sha256:/);

    // 2. The pinned fingerprint is accepted on reuse.
    const second = await transport.exec({
      ...base,
      command: "true",
      timeoutMs: 30_000,
      expectedFingerprint: fp ?? null,
    } satisfies HostExecRequest);
    expect(second.ok).toBe(true);

    // 3. A wrong expected fingerprint is a hard host-key-changed.
    const bad = await transport.exec({
      ...base,
      command: "true",
      timeoutMs: 30_000,
      expectedFingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    } satisfies HostExecRequest);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("host-key-changed");

    // 4. A slow command is cut by the timeout with partial output.
    const slow = await transport.exec({
      ...base,
      command: "echo started; sleep 60; echo never",
      timeoutMs: 3_000,
      expectedFingerprint: fp ?? null,
    } satisfies HostExecRequest);
    expect(slow.ok).toBe(true);
    if (slow.ok) {
      expect(slow.result.timedOut).toBe(true);
      expect(slow.result.exitCode).toBeNull();
      expect(slow.result.stdout).toContain("started");
    }

    transport.evict("ph_spike");
    delete process.env[names.keyFile];
    delete process.env[names.password];
  });
});
