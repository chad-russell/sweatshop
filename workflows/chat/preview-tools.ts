import { tool } from "ai";
import { z } from "zod";

/**
 * 0016: the preview tool definitions, shared by chats and machine agent
 * stages — each passes the step that runs the core in its own binding.
 * Schemas and descriptions live here once so the model sees the same
 * tools everywhere.
 */
export type PreviewAction = "start" | "status" | "stop";
export type PreviewRunner = (action: PreviewAction, input: Record<string, unknown>) => Promise<unknown>;

export function previewTools(run: PreviewRunner) {
  return {
    start_preview: tool({
      description:
        "Start (or restart) a long-running dev server in this sandbox and get a URL Chad can open in his " +
        "browser. It keeps running after this turn ends and shows as an Open button on the chat. Omit " +
        "command/port to infer them from package.json (install if needed + the dev script, bound to " +
        "0.0.0.0). The process gets PORT, HOST=0.0.0.0, PREVIEW_HOST (its public hostname) and PREVIEW_URL " +
        "in its env — apps that check allowed hosts (Vite server.allowedHosts, Next allowedDevOrigins) " +
        "must allow PREVIEW_HOST, and Vite HMR needs hmr.clientPort 443 (served over https). Calling it " +
        "again for the same directory and port restarts that preview instead of adding one.",
      inputSchema: z.object({
        dir: z.string().optional().describe("App directory (absolute, or relative to the work root); default: the only repo"),
        command: z.string().max(4_000).optional().describe("Shell command that starts the server in the foreground"),
        port: z.number().int().min(1).max(65_535).optional().describe("Port the server listens on (default 3000)"),
        label: z.string().max(60).optional().describe("Short name for the preview, e.g. the branch or app"),
      }),
      execute: (input) => run("start", input),
    }),

    preview_status: tool({
      description:
        "List this sandbox's previews (url, status, command), or pass an id for one preview's status and " +
        "the tail of its server log.",
      inputSchema: z.object({
        id: z.string().optional().describe("Preview id (pv_…) for status + log tail"),
        lines: z.number().int().min(1).max(500).optional().describe("Log lines (default 60)"),
      }),
      execute: (input) => run("status", input),
    }),

    stop_preview: tool({
      description: "Stop one of this sandbox's previews (its URL then shows a stopped page; start_preview brings it back).",
      inputSchema: z.object({ id: z.string().min(1).describe("Preview id (pv_…)") }),
      execute: (input) => run("stop", input),
    }),
  };
}
