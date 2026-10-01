/**
 * Stable identity of a sandbox's current container — the pi variant of
 * claude's bridge-IP cache eviction (0006): `hostname` inside the
 * container is its short container id, so it changes exactly when the
 * container is replaced (e.g. reaped by sandbox-gc and re-created by
 * the selector), which is the case where a cached in-process harness
 * session would otherwise keep running against a dead sandbox.
 *
 * eve memoizes one sandbox handle per session and installs a new one
 * when provider state is replaced, but the tool-context wrapper object
 * is fresh on every ctx.getSandbox() call — object identity is not a
 * usable cache key, so probe the container instead.
 */

/** The subset of eve's session-sandbox handle the probe needs. */
export interface EveSandboxShell {
  run(options: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * The container's hostname, or null when the probe fails — callers must
 * treat null as "identity unknown" (never reuse a cache), not as a
 * stable value.
 */
export async function sandboxContainerIdentity(
  sandbox: EveSandboxShell,
): Promise<string | null> {
  const result = await sandbox.run({ command: "hostname" });
  if (result.exitCode !== 0) return null;
  const id = result.stdout.trim();
  return id.length > 0 ? id : null;
}
