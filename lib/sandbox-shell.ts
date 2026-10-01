/**
 * The canonical sandbox shell seam (0004): anything that can run a
 * command inside a sandbox — directly provisioned containers
 * (lib/sandboxes/provision), eve session sandboxes (via a thin
 * wrapper), and test fakes. Git hosts, workspace setup, the harness
 * bridge, and the AI SDK adapter all speak this one shape; before it
 * existed, three near-identical interfaces had already drifted.
 */
export interface SandboxShell {
  run(
    command: string,
    env?: Record<string, string>,
    workingDirectory?: string,
  ): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
}
