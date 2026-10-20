import { tool } from "ai";
import { z } from "zod";
import { ownerName } from "../../lib/agent/owner";

/**
 * 0035: the attach_screenshot tool definition, shared by chats, agent
 * stages, and harness stages — each passes the runner that executes the
 * core in its own binding. One definition so the model sees the same
 * tool everywhere.
 */

export interface ScreenshotRunner {
  (input: { path: string; label?: string }): Promise<unknown>;
}

export function screenshotTool(run: ScreenshotRunner) {
  return tool({
    description:
      `Attach a PNG from this sandbox to the conversation so ${ownerName()} sees the actual image — ` +
      "QA evidence, a UI state, an error. The file must already exist: capture it first " +
      "(agent-browser screenshot <path> when the image has a browser), then attach that path. " +
      "PNG only, up to 10 MiB. Save screenshots under /work so they survive; /tmp works but " +
      "dies with the container.",
    inputSchema: z.object({
      path: z.string().min(1).describe("Path to the PNG inside this sandbox (absolute, or relative to the workDir)"),
      label: z.string().max(200).optional().describe("One line of context shown under the image, e.g. 'before' / 'after'"),
    }),
    execute: (input) => run(input),
  });
}
