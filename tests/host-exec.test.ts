import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "../db";
import { ensureConversation } from "../db/chat";
import { projects } from "../db/schema";
import { addProjectHost, getProjectHostByName } from "../db/hosts";
import { listHostCommands } from "../db/host-commands";
import { credentialEnvNames } from "../lib/hosts/credentials";
import type { HostExecOutcome, HostExecRequest, HostTransport } from "../lib/hosts/transport";
import { hostExecPreview, hostExecRun } from "../lib/agent/tools/host";
import { buildChatTools } from "../workflows/chat/tools";

/**
 * 0043 — the exec core over a FAKE transport (the ssh2 implementation
 * is the live spike's job) and the tool's presence in the chat set.
 */

const PROJECT = "p_0043x";
db().insert(projects).values({ id: PROJECT, name: "HostsX", createdAt: 0 }).onConflictDoNothing().run();

function chat(name: string): string {
  const id = `c_0043x_${name}`;
  ensureConversation(db(), id, PROJECT);
  return id;
}

// (No project teardown: the per-worker temp db is discarded, and the
// FK-ordered delete — host_commands, conversations, project_hosts —
// would only re-test the cascade.)

class FakeTransport implements HostTransport {
  calls: HostExecRequest[] = [];
  outcome: HostExecOutcome = {
    ok: true,
    result: { exitCode: 0, stdout: "up", stderr: "", durationMs: 5, timedOut: false },
  };

  async exec(req: HostExecRequest): Promise<HostExecOutcome> {
    this.calls.push(req);
    return this.outcome;
  }

  evict(): void {}
}

describe("hostExecPreview", () => {
  const keyVar = credentialEnvNames("bee").keyFile;
  const savedKey = process.env[keyVar];
  const dir = mkdtempSync(path.join(tmpdir(), "hostcred-"));
  const keyPath = path.join(dir, "id_ed25519");
  writeFileSync(keyPath, "KEY MATERIAL\n", { mode: 0o600 });
  process.env[keyVar] = keyPath;
  addProjectHost(db(), PROJECT, { name: "bee", address: "10.10.0.12", user: "crussell" });
  afterAll(() => {
    if (savedKey === undefined) delete process.env[keyVar];
    else process.env[keyVar] = savedKey;
  });

  it("accepts a known host with a credential", () => {
    const r = hostExecPreview(chat("preview"), { host: "bee", command: "uptime" });
    expect(r.ok).toBe(true);
  });

  it("lists the project's hosts when the name is unknown", () => {
    const bad = hostExecPreview(chat("preview"), { host: "nope", command: "uptime" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("unknown-host");
      expect(bad.message).toContain("bee");
    }
  });

  it("refuses without a credential, naming the env var", () => {
    addProjectHost(db(), PROJECT, { name: "credless", address: "h", user: "u" });
    const r = hostExecPreview(chat("preview2"), { host: "credless", command: "id" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("HOST_CREDLESS_SSH_KEY_FILE");
  });
});

describe("hostExecRun", () => {
  const keyVar = credentialEnvNames("bee").keyFile;
  const savedKey = process.env[keyVar];
  afterEach(() => {
    if (savedKey === undefined) delete process.env[keyVar];
    else process.env[keyVar] = savedKey;
  });

  function withKey(): void {
    const dir = mkdtempSync(path.join(tmpdir(), "hostcred-"));
    const key = path.join(dir, "id_ed25519");
    writeFileSync(key, "KEY MATERIAL\n", { mode: 0o600 });
    process.env[keyVar] = key;
  }

  it("runs an approved command: audit row resolved, result shaped", async () => {
    withKey();
    const cid = chat("run");
    const transport = new FakeTransport();
    const r = await hostExecRun(cid, { host: "bee", command: "uptime" }, transport);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("up");
    }
    expect(transport.calls[0]).toMatchObject({ host: "10.10.0.12", port: 22, username: "crussell" });
    expect(transport.calls[0]!.command).toBe("uptime");
    const rows = listHostCommands(db(), cid);
    expect(rows[0]!.exitCode).toBe(0);
    expect(rows[0]!.output).toContain("exit 0");
    expect(rows[0]!.resolvedAt).not.toBeNull();
  });

  it("pins the fingerprint on the first connect and sends it thereafter (TOFU)", async () => {
    withKey();
    const cid = chat("tofu");
    const transport = new FakeTransport();
    transport.outcome = {
      ok: true,
      result: { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, pinnedFingerprint: "sha256:feed" },
    };
    const first = await hostExecRun(cid, { host: "bee", command: "true" }, transport);
    expect(first.ok).toBe(true);
    expect(getProjectHostByName(db(), PROJECT, "bee")?.hostKeyFp).toBe("sha256:feed");
    expect(listHostCommands(db(), cid)[0]!.output).toContain("host key pinned");

    await hostExecRun(cid, { host: "bee", command: "true" }, transport);
    expect(transport.calls[1]!.expectedFingerprint).toBe("sha256:feed");
  });

  it("shapes connect failures, host-key changes, and timeouts — every attempt audited", async () => {
    withKey();
    const transport = new FakeTransport();

    transport.outcome = { ok: false, code: "connect-failed", message: "ECONNREFUSED" };
    let r = await hostExecRun(chat("fail"), { host: "bee", command: "x" }, transport);
    expect(r).toMatchObject({ ok: false, code: "connect-failed" });

    transport.outcome = { ok: false, code: "host-key-changed", message: "mismatch" };
    r = await hostExecRun(chat("fail2"), { host: "bee", command: "x" }, transport);
    expect(r).toMatchObject({ ok: false, code: "host-key-changed" });

    transport.outcome = {
      ok: true,
      result: { exitCode: null, stdout: "partial", stderr: "", durationMs: 120_000, timedOut: true },
    };
    r = await hostExecRun(chat("fail3"), { host: "bee", command: "long" }, transport);
    expect(r).toMatchObject({ ok: false, code: "timeout" });
    if (!r.ok) expect(r.stdout).toBe("partial");
    expect(transport.calls).toHaveLength(3); // one per attempt
  });

  it("clamps the timeout to 120–900s", async () => {
    withKey();
    const transport = new FakeTransport();
    await hostExecRun(chat("clamp"), { host: "bee", command: "x", timeout: 99_999 }, transport);
    expect(transport.calls[0]!.timeoutMs).toBe(900_000);
  });
});

// ── the tool set ─────────────────────────────────────────────────────

describe("buildChatTools: exec", () => {
  it("appears only for a project with hosts", () => {
    const withHosts = Object.keys(
      buildChatTools("c_x", {
        hasSandbox: false,
        hasProject: true,
        hosts: [{ name: "bee", address: "10.10.0.12", user: "crussell", apiBase: null }],
      }),
    );
    expect(withHosts).toContain("exec");

    const noHosts = Object.keys(buildChatTools("c_x", { hasSandbox: false, hasProject: true, hosts: [] }));
    expect(noHosts).not.toContain("exec");
    const noProject = Object.keys(
      buildChatTools("c_x", {
        hasSandbox: false,
        hasProject: false,
        hosts: [{ name: "bee", address: "10.10.0.12", user: "crussell", apiBase: null }],
      }),
    );
    expect(noProject).not.toContain("exec");
  });

  it("enumerates the hosts (address, user, api base) in its description", () => {
    const tools = buildChatTools("c_x", {
      hasSandbox: false,
      hasProject: true,
      hosts: [
        { name: "bee", address: "10.10.0.12", user: "crussell", apiBase: null },
        { name: "homeassistant", address: "192.168.20.51", user: "hassio", apiBase: "http://192.168.20.51:8123" },
      ],
    });
    const description = (tools.exec as { description: string }).description;
    expect(description).toContain("bee (crussell@10.10.0.12)");
    expect(description).toContain("homeassistant (hassio@192.168.20.51");
    expect(description).toContain("http://192.168.20.51:8123");
  });
});
