import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Client as Ssh2Client } from "ssh2";
import type { HostCredential } from "./credentials";

/**
 * 0043: the SSH transport behind the `exec` tool — the one place a real
 * host is touched. A seam (HostTransport) so unit tests never open a
 * socket; the ssh2 implementation here is exercised by the opt-in live
 * spike (tests/host-spike.integration.test.ts).
 *
 * Host keys are TOFU-pinned to the registry row: the first successful
 * connect reports the fingerprint it saw (the core persists it, and the
 * audit row notes the pinning); every later connect must match, else a
 * hard `host-key-changed` — never an interactive prompt, never a silent
 * accept. One pooled connection per host id, keepalive between calls,
 * evicted on any error (the next exec reconnects and re-verifies).
 */

export interface HostExecRequest {
  /** Registry id — the pool key (not the address: re-resolution is per call). */
  hostId: string;
  host: string;
  port: number;
  username: string;
  credential: HostCredential;
  command: string;
  timeoutMs: number;
  /** `sha256:…` pinned on the registry row; null = first connect (TOFU). */
  expectedFingerprint: string | null;
}

export interface HostExecOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** The wall clock ran out; output is partial and exitCode is null. */
  timedOut: boolean;
  /** Set when expectedFingerprint was null and this connect pinned one. */
  pinnedFingerprint?: string;
}

export type HostExecOutcome =
  | { ok: true; result: HostExecOutput }
  | { ok: false; code: "host-key-changed" | "connect-failed"; message: string };

export interface HostTransport {
  exec(req: HostExecRequest): Promise<HostExecOutcome>;
  /** Drop pooled state for a host (registry removal, tests). */
  evict(hostId: string): void;
}

/** Quote one word for the remote `bash -lc` invocation. */
export function shellSingleQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function fingerprintOf(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

interface Pooled {
  client: Ssh2Client;
  fingerprint: string;
}

const pool = new Map<string, Pooled>();

/**
 * ssh2 loads through createRequire ON PURPOSE: the workflow compiler
 * (esbuild) bundles every module a step can reach, and ssh2's optional
 * native addons (`sshcrypto.node`, `cpu-features`) are statically
 * required by its JS — bundling them fails with "no loader is
 * configured for .node files". better-sqlite3 slips through only
 * because its `bindings` package resolves the .node at runtime; this is
 * the same posture, made explicit. The runtime require resolves
 * node_modules normally in every consumer (app container, test worker).
 */
const require = createRequire(import.meta.url);
const { Client } = require("ssh2") as typeof import("ssh2");

function evictClient(entry: Pooled | undefined): void {
  if (!entry) return;
  try {
    entry.client.end();
  } catch {
    // already gone
  }
}

/**
 * Connect (or reuse) the pooled client for `req.hostId`. Resolves the
 * pinned fingerprint seen on THIS connect (equal to expected when one
 * was pinned); rejects on failure.
 */
function connect(req: HostExecRequest): Promise<Pooled> {
  const existing = pool.get(req.hostId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    let seen: string | null = null;
    let settled = false;
    const client = new Client();
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        // already gone
      }
      reject(new Error(message));
    };
    client
      .on("ready", () => {
        if (settled) return;
        settled = true;
        const entry = { client, fingerprint: seen ?? "" };
        pool.set(req.hostId, entry);
        // A dead pooled client must not poison the next exec: errors
        // evict so the caller reconnects on its next attempt.
        client.on("error", () => {
          if (pool.get(req.hostId) === entry) pool.delete(req.hostId);
          evictClient(entry);
        });
        client.on("close", () => {
          if (pool.get(req.hostId) === entry) pool.delete(req.hostId);
        });
        resolve(entry);
      })
      .on("error", (err: Error) => fail(err.message))
      .connect({
        host: req.host,
        port: req.port,
        username: req.username,
        ...(req.credential.kind === "key"
          ? { privateKey: req.credential.privateKey, ...(req.credential.passphrase ? { passphrase: req.credential.passphrase } : {}) }
          : { password: req.credential.password }),
        // TOFU / pin check: returning false aborts the handshake.
        hostVerifier: (key: Buffer) => {
          seen = fingerprintOf(key);
          return req.expectedFingerprint === null || seen === req.expectedFingerprint;
        },
        readyTimeout: Math.min(30_000, req.timeoutMs),
        keepaliveInterval: 15_000,
      });
  });
}

export const ssh2Transport: HostTransport = {
  async exec(req) {
    let entry: Pooled;
    try {
      entry = await connect(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // ssh2 reports a hostVerifier rejection as a generic handshake
      // error — name it for what the core needs to say.
      const changed = req.expectedFingerprint !== null && /verification|man-in-the-middle|handshake/i.test(message);
      return {
        ok: false,
        code: changed ? "host-key-changed" : "connect-failed",
        message: changed
          ? `host key for ${req.username}@${req.host} does not match the pinned fingerprint — refusing to connect`
          : `could not connect to ${req.username}@${req.host}:${req.port} — ${message}`,
      };
    }
    const pinned = req.expectedFingerprint === null ? entry.fingerprint : undefined;
    const started = Date.now();
    return new Promise<HostExecOutcome>((resolve) => {
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      let timedOut = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: true,
          result: {
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - started,
            timedOut,
            ...(pinned ? { pinnedFingerprint: pinned } : {}),
          },
        });
      };
      const timer = setTimeout(() => {
        // The channel state is unknown after a kill — evict the pooled
        // connection so the next exec reconnects cleanly.
        timedOut = true;
        if (pool.get(req.hostId) === entry) pool.delete(req.hostId);
        evictClient(entry);
        finish();
      }, req.timeoutMs);
      entry.client.exec(`bash -lc ${shellSingleQuote(req.command)}`, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolve({ ok: false, code: "connect-failed", message: `exec failed: ${err.message}` });
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          exitCode = code;
          finish();
        });
        // The stream may end without a close on some servers; guard
        // with the channel's own end signal.
        stream.on("end", () => {
          if (!settled && exitCode !== null) finish();
        });
      });
    });
  },

  evict(hostId) {
    evictClient(pool.get(hostId));
    pool.delete(hostId);
  },
};
