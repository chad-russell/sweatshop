import { readFileSync } from "node:fs";

/**
 * 0043: credential resolution for the host channel. The app's env is the
 * REGISTRY, keyed by host name (uppercased, non-alphanumerics → `_`):
 *
 *   HOST_<NAME>_SSH_KEY_FILE       path to a 0600 private key file
 *                                  (keys are files because podman env
 *                                  files cannot hold multiline values)
 *   HOST_<NAME>_SSH_KEY_PASSPHRASE optional passphrase for that key
 *   HOST_<NAME>_SSH_PASSWORD       inline password (hosts that only do
 *                                  password auth — the HA SSH add-on
 *                                  until it's converted to a key)
 *
 * One credential per host NAME, global across projects — two projects
 * listing a host named `bees` share it. Read at call time, never cached:
 * an env edit lands on the next exec after a service restart.
 */

export type HostCredential =
  | { kind: "key"; privateKey: Buffer; passphrase?: string }
  | { kind: "password"; password: string };

export interface CredentialEnvNames {
  keyFile: string;
  keyPassphrase: string;
  password: string;
}

export function credentialEnvNames(hostName: string): CredentialEnvNames {
  const v = hostName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    keyFile: `HOST_${v}_SSH_KEY_FILE`,
    keyPassphrase: `HOST_${v}_SSH_KEY_PASSPHRASE`,
    password: `HOST_${v}_SSH_PASSWORD`,
  };
}

export type CredentialResolution =
  | { ok: true; credential: HostCredential }
  | { ok: false; code: "no-credential"; envNames: CredentialEnvNames; message: string };

export function resolveHostCredential(hostName: string, env: NodeJS.ProcessEnv = process.env): CredentialResolution {
  const names = credentialEnvNames(hostName);
  const keyFile = env[names.keyFile]?.trim();
  if (keyFile) {
    try {
      const passphrase = env[names.keyPassphrase]?.trim();
      return {
        ok: true,
        credential: { kind: "key", privateKey: readFileSync(keyFile), ...(passphrase ? { passphrase } : {}) },
      };
    } catch (err) {
      return {
        ok: false,
        code: "no-credential",
        envNames: names,
        message: `${names.keyFile} points at ${keyFile}, which cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  const password = env[names.password];
  if (password) return { ok: true, credential: { kind: "password", password } };
  return {
    ok: false,
    code: "no-credential",
    envNames: names,
    message: `no credential for host "${hostName}" — set ${names.keyFile} (path to a private key) or ${names.password} in the app's environment`,
  };
}
