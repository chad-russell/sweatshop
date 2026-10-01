import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BaseBuilder, createBaseBuilderConfig } from "@workflow/builders";

/**
 * 0010 spike: an in-process executor for workflow runs under vitest.
 *
 * The Workflow SDK's local world delivers run messages over HTTP to
 * `/.well-known/workflow/v1/flow` — in Next dev, withWorkflow mounts that
 * route. Vitest has no server, so these tests build the workflow bundle
 * the same way the dev server does (BaseBuilder + createCombinedBundle,
 * the SDK's own dev/workbench path), import its POST handler, and serve it
 * on an ephemeral loopback port that WORKFLOW_LOCAL_BASE_URL points at.
 *
 * The test process itself still imports the transformed workflow modules
 * (the vitest `workflow()` plugin adds the workflowId `start()` needs);
 * only run EXECUTION comes from this prebuilt bundle — the same split the
 * SDK's workbench uses (see MOCKING.md, "prebuilt step bundle").
 */

class DevBuilder extends BaseBuilder {
  /** The dev build this harness needs (LocalBuilder calls this internally). */
  async build(): Promise<void> {
    /* replaced by buildDev below */
  }

  /** Expose the protected dev build (same shape as the nitro LocalBuilder). */
  async buildDev(stepsOutfile: string, flowOutfile: string): Promise<void> {
    const inputFiles = await this.getInputFiles();
    await this.createCombinedBundle({
      inputFiles,
      stepsOutfile,
      flowOutfile,
      format: "esm",
      // Match nitro dev: let the import of the output modules resolve the
      // workflow runtime from this repo's node_modules, not a copy.
      bundleFinalOutput: false,
      externalizeNonSteps: true,
    });
  }
}

export interface WorkflowExecutor {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startWorkflowExecutor(): Promise<WorkflowExecutor> {
  // The generated bundles resolve runtime imports via node_modules, so the
  // output must live under the repo (like every dev-server build dir) —
  // .workflow-data/ is gitignored workflow state.
  const dir = path.join(
    process.cwd(),
    ".workflow-data",
    `test-exec-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  const stepsOutfile = path.join(dir, "steps.mjs");
  const flowOutfile = path.join(dir, "workflows.mjs");

  const builder = new DevBuilder({
    ...createBaseBuilderConfig({
      workingDir: process.cwd(),
      // Only the chat workflow tree: the executor imports the generated
      // bundles with plain Node resolution (no bundler aliases), so the
      // "@/..." imports of the machines tree must stay out of it.
      dirs: ["workflows/chat"],
      watch: false,
      // Native/troublesome packages must stay external in the steps bundle.
      externalPackages: [
        "better-sqlite3",
        "@ai-sdk/harness",
        "@ai-sdk/harness-pi",
        "@ai-sdk/harness-claude-code",
        "@ai-sdk/workflow-harness",
        "@earendil-works/pi-coding-agent",
      ],
    }),
    buildTarget: "next", // placeholder, mirrors LocalBuilder
  });
  await builder.buildDev(stepsOutfile, flowOutfile);

  // Load the generated flow route (POST = workflowEntrypoint(...)).
  const mod = (await import(/* @vite-ignore */ pathToFileURL(flowOutfile).href)) as {
    POST: (request: Request) => Promise<Response>;
  };
  // Steps must be registered in this process too (the flow route imports
  // the steps bundle next to itself; this cache-busts nothing, it just
  // mirrors the nitro dev handler's explicit import).
  await import(/* @vite-ignore */ pathToFileURL(stepsOutfile).href);

  let port = 0;
  const server: Server = await new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      try {
        // Rebuild the absolute URL from the server's own address: the
        // SDK's node-http queue client does not always send a Host header.
        const request = await toWebRequest(req, port);
        const response = await mod.POST(request);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(err instanceof Error ? err.stack ?? err.message : String(err));
      }
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("workflow executor: no port");
  }
  port = address.port;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.WORKFLOW_LOCAL_BASE_URL = baseUrl;

  return {
    baseUrl,
    async close() {
      // The queue's HTTP agents hold keep-alive sockets open; a plain
      // close() would wait on them forever (vitest's afterAll then trips
      // its 10s hookTimeout), so drop the connections first.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function toWebRequest(req: IncomingMessage, port: number): Promise<Request> {
  return readBody(req).then(
    (body) =>
      new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(body),
      }),
  );
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk as Buffer));
  return new Promise((resolve, reject) => {
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
