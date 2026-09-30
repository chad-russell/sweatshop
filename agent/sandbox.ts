import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

/**
 * 0004 Phase A spike — hardcoded, project-free proof of the sandbox
 * plane: eve's Docker provider drives the docker CLI inside the dev
 * container, which talks to the host rootless podman socket, so this
 * sandbox runs as a SIBLING container on host podman. Every durable
 * session opens its own instance.
 *
 * Phase B replaces the hardcoded clone with project entities + GitHost
 * credential injection; the structure below is the shape it keeps.
 */
export const environment = DockerSandbox.environment({
  // Bake git into the prepared image if the base image lacks it (prepare
  // runs once per environment generation, not per session).
  prepare: async (sandbox) => {
    const check = await sandbox.run({ command: "command -v git" });
    if (check.exitCode === 0) return;
    const install = await sandbox.run({
      command:
        "apt-get update && apt-get install -y --no-install-recommends git",
    });
    if (install.exitCode !== 0) throw new Error(install.stderr);
  },
});

const SPIKE_REPO = "https://github.com/jonschlinkert/is-odd";

export default defineSandbox(async () => {
  // allow-all: the clone needs egress (Docker supports only coarse
  // allow/deny; fine-grained egress arrives with a custom provider).
  const sandbox = await environment.open({ networkPolicy: "allow-all" });

  // Idempotent-ish session setup: clone the scratch repo if absent.
  // GIT_TERMINAL_PROMPT=0 keeps clone failures clean instead of hanging
  // on an interactive credential prompt.
  const clone = await sandbox.run({
    command: `[ -d /workspace/repo ] || GIT_TERMINAL_PROMPT=0 git clone --depth 5 ${SPIKE_REPO} /workspace/repo`,
  });
  if (clone.exitCode !== 0) throw new Error(clone.stderr);

  return sandbox;
});
