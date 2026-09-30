import { helloWorkflow } from "@/workflows/hello";
import { start } from "workflow/api";

export const dynamic = "force-dynamic";

/** Spike: start the hello workflow and report the run. */
export async function GET() {
  const run = await start(helloWorkflow, ["world"]);
  const result = await run.returnValue;
  return Response.json({ result });
}
