/**
 * Coexistence spike (0004 Path B): a minimal app-level Workflow SDK
 * workflow running alongside eve's own workflow runtime. If this runs,
 * `start()` from API routes works under withEve(withWorkflow(...)).
 */
export async function helloWorkflow(name: string) {
  "use workflow";
  return `hello ${name} at ${await timestamp()}`;
}

async function timestamp() {
  "use step";
  return new Date().toISOString();
}
