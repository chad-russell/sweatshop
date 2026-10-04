/**
 * Next's instrumentation hook. Everything real is Node-only and lives in
 * instrumentation-node.ts (the 0013 reaper, the 0016 preview proxy and
 * tick); the guarded dynamic import keeps it out of the edge bundle.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
