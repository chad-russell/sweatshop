import type { Experimental_SandboxSession } from "ai";
import type { PreviewNetwork } from "../../lib/previews/network";
import type { SandboxHandle, SandboxProvider } from "../../lib/sandboxes/provider";

/**
 * The scripted sandbox the preview tests run against (no podman): it
 * models only what the preview service observes — a pid file per
 * preview that the launch script writes and the kill script removes,
 * plus a scripted "does it answer HTTP" per container. Shared by the
 * 0016 preview suite and the 0036 harness-stage tool tests.
 */
export class FakeSandbox implements SandboxProvider {
  readonly kind = "podman";
  /** preview id → alive */
  alive = new Map<string, boolean>();
  /** ref:port → answers HTTP */
  answers = new Set<string>();
  /** What a launch does: "serve" comes up, "die" exits at once, "hang" never answers. */
  behavior: "serve" | "die" | "hang" = "serve";
  scripts: { command: string; env?: Record<string, string> }[] = [];
  files = new Map<string, string>();
  log: string[] = [];
  async create(): Promise<SandboxHandle> {
    throw new Error("unused");
  }
  attach(ref: string): SandboxHandle {
    return {
      ref,
      run: async (command, env) => {
        this.scripts.push({ command, ...(env ? { env } : {}) });
        const pidMatch = /\/work\/\.previews\/(pv_[A-Za-z0-9_-]+)\.pid/.exec(command);
        const id = pidMatch?.[1];
        if (command.includes("setsid nohup") && id) {
          const port = env?.PORT ?? "0";
          this.alive.set(id, this.behavior !== "die");
          if (this.behavior === "serve") this.answers.add(`${ref}:${port}`);
          else this.answers.delete(`${ref}:${port}`);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("kill -TERM") && id) {
          this.alive.set(id, false);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("echo alive") && id) {
          return { exitCode: 0, stdout: this.alive.get(id) ? "alive\n" : "", stderr: "" };
        }
        if (command.startsWith("tail -n")) return { exitCode: 0, stdout: "boom: missing module\n", stderr: "" };
        if (command.includes("__ROOT__")) {
          return { exitCode: 0, stdout: this.files.get("scan") ?? "", stderr: "" };
        }
        if (command.includes("cat package.json")) {
          return { exitCode: 0, stdout: this.files.get("listing") ?? "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: (() => {
        throw new Error("unused");
      }) as unknown as Experimental_SandboxSession["spawn"],
    };
  }
  async stop(ref: string) {
    this.log.push(`stop ${ref}`);
  }
  async resume(ref: string) {
    this.log.push(`resume ${ref}`);
  }
  async destroy(ref: string) {
    this.log.push(`destroy ${ref}`);
  }
}

/** A preview network fake recording which sandbox refs got connected. */
export function networkFor(sbx: FakeSandbox): PreviewNetwork & { connected: string[] } {
  const connected: string[] = [];
  return {
    connected,
    async connect(ref) {
      connected.push(ref);
    },
    target: (ref, port) => ({ host: ref, port }),
    probe: async (ref, port) => sbx.answers.has(`${ref}:${port}`),
  };
}

/** Fast health polling for tests. */
export const fast = { healthTimeoutMs: 30, pollMs: 1 };
