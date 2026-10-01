import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";
import { sessionProjectId } from "../lib/session-attributes";
import { setupProjectWorkspace } from "../lib/sandboxes/setup";

/**
 * 0004 project sandbox (Path A): every durable session opens its own
 * sibling container on host podman (Phase A) and gets the bound
 * project's repos cloned into /workspace/<repo> with host-scoped git
 * credentials installed. Binding comes from the session's initiating
 * principal (x-sweatshop-project → channel auth attributes), immutable
 * for the session's life. Workspace provisioning is shared with
 * directly provisioned containers via lib/sandboxes/setup.
 */
export const environment = DockerSandbox.environment({
  // Bake git into the prepared image if the base image lacks it (prepare
  // runs once per environment generation, not per session). image_ref on
  // sandbox_configs is schema-ready but unused in v1 (shared base image,
  // decision 2).
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

export default defineSandbox(async ({ session }) => {
  const projectId = sessionProjectId(session);

  // Decision 4: non-project conversations get no sandbox — the error must
  // be self-explanatory because it surfaces as the failure of whatever
  // tool call first touched the sandbox (Phase A gotcha).
  if (!projectId) {
    throw new Error(
      "no project bound to this conversation — bash/file tools are only available in project conversations (start one from a project page)",
    );
  }

  // v1 egress is coarse (docker provider: allow/deny-all); project work
  // needs egress for clones/pushes.
  const sandbox = await environment.open({ networkPolicy: "allow-all" });
  await setupProjectWorkspace(
    { run: (command) => sandbox.run({ command }) },
    projectId,
  );
  return sandbox;
});
