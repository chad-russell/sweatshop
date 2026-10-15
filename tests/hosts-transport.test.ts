import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { credentialEnvNames, resolveHostCredential } from "../lib/hosts/credentials";
import { shellSingleQuote } from "../lib/hosts/transport";

/**
 * 0043 — env credential resolution (the registry) and the bash -lc
 * quoting. Pure modules; no sockets.
 */

describe("resolveHostCredential", () => {
  const keyFile = credentialEnvNames("homeassistant").keyFile;
  const passwordVar = credentialEnvNames("homeassistant").password;
  const saved: Record<string, string | undefined> = {
    [keyFile]: process.env[keyFile],
    [passwordVar]: process.env[passwordVar],
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("names env vars from the host name", () => {
    expect(credentialEnvNames("bee")).toEqual({
      keyFile: "HOST_BEE_SSH_KEY_FILE",
      keyPassphrase: "HOST_BEE_SSH_KEY_PASSPHRASE",
      password: "HOST_BEE_SSH_PASSWORD",
    });
  });

  it("resolves a key file, then a password, and says which var it wanted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hostcred-"));
    const key = path.join(dir, "id_ed25519");
    writeFileSync(key, "KEY MATERIAL\n", { mode: 0o600 });

    process.env[keyFile] = key;
    delete process.env[passwordVar];
    const byKey = resolveHostCredential("homeassistant");
    expect(byKey.ok).toBe(true);
    if (byKey.ok) expect(byKey.credential.kind).toBe("key");

    delete process.env[keyFile];
    const none = resolveHostCredential("homeassistant");
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.code).toBe("no-credential");
      expect(none.message).toContain("HOST_HOMEASSISTANT_SSH_KEY_FILE");
    }

    process.env[passwordVar] = "s3cret";
    const byPassword = resolveHostCredential("homeassistant");
    expect(byPassword.ok).toBe(true);
    if (byPassword.ok) expect(byPassword.credential.kind).toBe("password");
  });

  it("reports an unreadable key file as no-credential with the reason", () => {
    process.env[keyFile] = "/nonexistent/id_ed25519";
    delete process.env[passwordVar];
    const r = resolveHostCredential("homeassistant");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("/nonexistent/id_ed25519");
  });
});

// ── shellSingleQuote (the bash -lc wrapping) ─────────────────────────

describe("shellSingleQuote", () => {
  it("quotes safely, including embedded quotes", () => {
    expect(shellSingleQuote("uptime")).toBe("'uptime'");
    expect(shellSingleQuote("echo 'hi'")).toBe("'echo '\\''hi'\\'''");
    expect(shellSingleQuote("a\nb")).toBe("'a\nb'");
  });
});
