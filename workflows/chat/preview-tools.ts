import { tool } from "ai";
import { z } from "zod";

/**
 * 0016/0017: the preview tool definitions, shared by chats and machine
 * agent stages — each passes the step that runs the core in its own
 * binding. Schemas and descriptions live here once so the model sees
 * the same tools everywhere.
 */
export type PreviewAction = "start" | "status" | "stop" | "get-setup" | "save-setup";
export type PreviewRunner = (action: PreviewAction, input: Record<string, unknown>) => Promise<unknown>;

export function previewTools(run: PreviewRunner) {
  return {
    start_preview: tool({
      description:
        "Start (or restart) a long-running dev server in this sandbox and get a URL Chad can open in his " +
        "browser. It keeps running after this turn ends and shows as an Open button on the chat. With the " +
        "project's saved setup (get_preview_setup), dir/command/port/env all default from it; otherwise " +
        "omitting command/port prefills from this directory's package.json. The process's env = the setup's " +
        "env + your sparse `env` overrides + platform vars (PORT, HOST=0.0.0.0, PREVIEW_HOST, PREVIEW_URL — " +
        "always final). Apps that check allowed hosts (Vite server.allowedHosts, Next allowedDevOrigins) " +
        "must allow PREVIEW_HOST, and Vite HMR needs hmr.clientPort 443 (served over https). Calling it " +
        "again for the same directory and port restarts that preview instead of adding another.",
      inputSchema: z.object({
        dir: z.string().optional().describe("App directory (absolute, or relative to the work root); default: the setup's, else the only repo"),
        command: z.string().max(4_000).optional().describe("Shell command that starts the server in the foreground"),
        port: z.number().int().min(1).max(65_535).optional().describe("Port the server listens on (default: the setup's, else 3000)"),
        label: z.string().max(60).optional().describe("Short name for the preview, e.g. the branch or app"),
        env: z.record(z.string(), z.string()).optional().describe("Sparse env overrides for this preview, merged over the setup's env"),
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

    get_preview_setup: tool({
      description:
        "The project's saved preview setup (workDir, install, command, port, env with plaintext values, " +
        "declared services) — or null when none exists. start_preview uses it automatically; read it " +
        "before passing command/port/env yourself.",
      inputSchema: z.object({}),
      execute: () => run("get-setup", {}),
    }),

    save_preview_setup: tool({
      description:
        "Save (or replace) the project's preview setup — the explicit, saved answer to 'how does this " +
        "project run', used by every later preview and start_preview call. Full definition required (the " +
        "current one comes back from get_preview_setup; edit it rather than guessing). Invalid definitions " +
        "return per-field issues and save nothing.",
      inputSchema: z.object({
        definition: z.object({
          repo: z.string().describe("project_repos id — must belong to this project"),
          workDir: z.string().describe("Directory the server runs in, relative to the repo root"),
          install: z.string().describe("Dependency install, run at the repo root"),
          provision: z.string().optional().describe("One-shot post-services step (migrations)"),
          command: z.string().describe("Server command; $PORT is the preview's port"),
          port: z.number().int().min(1).max(65_535),
          env: z.record(z.string(), z.string()).describe("Env for every preview (values may reference ${PREVIEW_URL}, ${PREVIEW_HOST}, ${PORT}, ${HOST})"),
          services: z.array(z.object({
            name: z.string(), image: z.string(), command: z.string().optional(),
            env: z.record(z.string(), z.string()), port: z.number().int(),
          })).describe("Declared service dependencies (running starts with 0017 phase 3)"),
        }),
      }),
      execute: (input) => run("save-setup", input),
    }),
  };
}
