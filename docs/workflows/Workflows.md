### Configure Start Script

Source: https://github.com/vercel/workflow/blob/main/packages/web/README.md

Defines a start script in package.json to launch the web UI from the installed package.

```json
{
  "scripts": {
    "start": "cd node_modules/@workflow/web && next start -p $PORT"
  }
}
```

--------------------------------

### Deploy Published Package

Source: https://github.com/vercel/workflow/blob/main/packages/web/README.md

Installs the package and starts the Next.js server from the node_modules directory.

```bash
mkdir workflow-observability-ui
cd workflow-observability-ui

npm init -y
# You must provide React runtime dependencies in your host project.
npm i @workflow/web react react-dom

# Run Next.js from the installed package (it contains the .next output)
cd node_modules/@workflow/web
npx --yes next start -p "${PORT:-3456}"
```

--------------------------------

### Hono Framework App Boundary Example

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/runtime-targets.md

This example shows how to start a workflow within a Hono framework application. It defines a POST route to initiate the onboarding workflow.

```typescript
import { Hono } from 'hono';
import { start } from 'workflow/api';
import { onboardingWorkflow } from '../workflows/onboarding';

const app = new Hono();

app.post('/api/onboarding/start', async (c) => {
  const body = (await c.req.json()) as { userId: string };
  const run = await start(onboardingWorkflow, [body.userId]);
  return c.json({ runId: run.runId });
});

export default app;
```

--------------------------------

### Install @workflow/ai

Source: https://github.com/vercel/workflow/blob/main/packages/ai/README.md

Install the core library package.

```bash
npm install @workflow/ai
```

--------------------------------

### Build and Start Production Server

Source: https://github.com/vercel/workflow/blob/main/workbench/tanstack-start/README.md

Commands to build the project for production and then start the production server.

```sh
pnpm build && pnpm start
```

--------------------------------

### Build and Run Example Applications

Source: https://github.com/vercel/workflow/blob/main/AGENTS.md

Commands for building workflow bundles and executing CLI commands within the example workbench directory.

```bash
# Build workflow bundles for example app
cd workbench/example && pnpm build

# Use workflow CLI directly
cd workbench/example && pnpm workflow [command]
cd workbench/example && pnpm wf [command]  # shorthand
```

--------------------------------

### Run Development Environment

Source: https://github.com/vercel/workflow/blob/main/README.md

Commands to start the application and the local observability UI.

```bash
npm run dev
```

```bash
npx workflow web
```

--------------------------------

### Install @workflow/world-postgres

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md

Installation commands for various package managers.

```bash
npm install @workflow/world-postgres
# or
pnpm add @workflow/world-postgres
# or
yarn add @workflow/world-postgres
```

--------------------------------

### Framework-Agnostic App Boundary Example

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/runtime-targets.md

This example demonstrates starting a workflow from a framework-agnostic API endpoint using plain Request and Response objects. It's suitable when a framework-agnostic approach is required, even if specific frameworks are mentioned elsewhere.

```typescript
import { start } from 'workflow/api';
import { onboardingWorkflow } from '../workflows/onboarding';

export async function POST(request: Request) {
  const body = (await request.json()) as { userId: string };
  const run = await start(onboardingWorkflow, [body.userId]);
  return Response.json({ runId: run.runId });
}
```

--------------------------------

### Initialize and Run the Python Workbench

Source: https://github.com/vercel/workflow/blob/main/workbench/python/README.md

Commands to synchronize dependencies and start the Uvicorn development server.

```bash
cd workbench/python
uv sync --locked
WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev     # uvicorn on :3000
```

--------------------------------

### Run Development Server

Source: https://github.com/vercel/workflow/blob/main/workbench/tanstack-start/README.md

Use this command to start the development server for the TanStack Start workbench.

```sh
pnpm dev
```

--------------------------------

### Install Workflow SDK

Source: https://github.com/vercel/workflow/blob/main/README.md

Install the package via npm to begin using the SDK in your project.

```bash
npm install workflow
```

--------------------------------

### Run local end-to-end benchmark

Source: https://github.com/vercel/workflow/blob/main/packages/core/scripts/README.md

Start the local development server and run the benchmark suite against it.

```bash
# Local World (nextjs-turbopack dev server on :3000)
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev &
# From repo root
DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
```

--------------------------------

### Local Development Setup

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md

Commands to initialize the PostgreSQL database, run migrations, and configure environment variables for local development.

```bash
# Start PostgreSQL database
docker-compose up -d

# Create and run migrations
pnpm drizzle-kit generate
pnpm drizzle-kit migrate

# Set environment variables for local development
export WORKFLOW_POSTGRES_URL="postgres://world:world@localhost:5432/world"
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
```

--------------------------------

### Start and Collect Child Workflow

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/shared-patterns.md

Demonstrates starting a child workflow using `start` and collecting its result using `getRun`. The `childWorkflow` is defined with `'use workflow'` and `doWork` with `'use step'`.

```typescript
import { getRun, start } from 'workflow/api';

export async function childWorkflow(input: string) {
  'use workflow';
  return await doWork(input);
}

async function doWork(input: string) {
  'use step';
  return { input, status: 'done' as const };
}

async function spawnChild(input: string): Promise<string> {
  'use step';
  const run = await start(childWorkflow, [input]);
  return run.runId;
}

async function collectChild(runId: string) {
  'use step';
  const run = getRun(runId);
  return (await run.returnValue) as { input: string; status: 'done' };
}
```

--------------------------------

### Install AI SDK versions

Source: https://github.com/vercel/workflow/blob/main/packages/ai/README.md

Install the required AI SDK version as a peer dependency.

```bash
# For AI SDK v6 (recommended, latest)
npm install ai

# For AI SDK v5
npm install ai@5
```

--------------------------------

### Install @workflow/nest and dependencies

Source: https://github.com/vercel/workflow/blob/main/packages/nest/README.md

Install the core package and required SWC dependencies for the NestJS builder.

```bash
npm install @workflow/nest
# or
pnpm add @workflow/nest
```

```bash
npm install -D @swc/cli @swc/core
# or
pnpm add -D @swc/cli @swc/core
```

--------------------------------

### Initialize Postgres World in SvelteKit

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Use the server hooks file to trigger the world start process during server initialization.

```ts
import type { ServerInit } from "@sveltejs/kit";

export const init: ServerInit = async () => {
  const { getWorld } = await import("workflow/runtime");
  const world = await getWorld();
  await world.start?.();
};
```

--------------------------------

### Install provider packages

Source: https://github.com/vercel/workflow/blob/main/packages/ai/README.md

Install specific provider packages when using @workflow/ai wrappers.

```bash
# Example: Using Anthropic with AI SDK v6
npm install ai @ai-sdk/anthropic

# Example: Using OpenAI with AI SDK v5
npm install ai@5 @ai-sdk/openai@2
```

--------------------------------

### Initialize Postgres World in Nitro

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Create a plugin to start the world and register it within the Nitro configuration.

```ts
import { defineNitroPlugin } from "nitro/~internal/runtime/plugin";

export default defineNitroPlugin(async () => {
  const { getWorld } = await import("workflow/runtime");
  const world = await getWorld();
  await world.start?.();
});
```

```ts
import { defineNitroConfig } from "nitropack";

export default defineNitroConfig({
  modules: ["workflow/nitro"],
  plugins: ["plugins/start-pg-world.ts"],
});
```

--------------------------------

### Start workflows from API routes

Source: https://github.com/vercel/workflow/blob/main/skills/workflow/SKILL.md

Use the start function to initiate workflows from API routes. Note that start cannot be called directly within a workflow context.

```typescript
import { start } from "workflow/api";

// From an API route; works directly
export async function POST() {
  const run = await start(myWorkflow, [arg1, arg2]);
  return Response.json({ runId: run.runId });
}

// No-args workflow
const run = await start(noArgWorkflow);
```

--------------------------------

### Install Postgres World package

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Install the required package for the Postgres World integration.

```bash
@workflow/world-postgres
```

--------------------------------

### Run Web UI with CLI

Source: https://github.com/vercel/workflow/blob/main/packages/web/README.md

Starts the web UI on the default port 3456 using the Workflow CLI.

```bash
npx workflow web --noBrowser
```

--------------------------------

### Initialize Postgres World in Next.js

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Use the instrumentation file to register the world start process, ensuring it only runs in the Node.js runtime.

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    const { getWorld } = await import("workflow/runtime");
    const world = await getWorld();
    await world.start?.();
  }
}
```

--------------------------------

### E2E testing against Vercel production

Source: https://github.com/vercel/workflow/blob/main/CLAUDE.md

Example command for running E2E tests against a deployed Vercel preview or production environment using required environment variables.

```bash
NODE_OPTIONS="--enable-source-maps" \
DEPLOYMENT_URL="https://example-nextjs-workflow-turbopack-<hash>.labs.vercel.dev" \
VERCEL_DEPLOYMENT_ID="dpl_..." \
APP_NAME="nextjs-turbopack" \
WORKFLOW_VERCEL_ENV="preview" \
WORKFLOW_VERCEL_AUTH_TOKEN="<vercel_labs_token>" \
WORKFLOW_VERCEL_TEAM="team_nO2mCG4W8IxPIeKoSsqwAxxB" \
WORKFLOW_VERCEL_PROJECT="prj_yjkM7UdHliv8bfxZ1sMJQf1pMpdi" \
WORKFLOW_VERCEL_PROJECT_SLUG="example-nextjs-workflow-turbopack" \
VERCEL_OIDC_TOKEN="$(grep VERCEL_OIDC_TOKEN workbench/nextjs-turbopack/.env.local | cut -d= -f2-)" \
pnpm run test:e2e
```

--------------------------------

### Start Workflow World Helper Function

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/evals/non-vercel-runtime-branch.md

A helper function to initialize the workflow world by calling its start method if available. This is useful for setting up the environment before workflow execution.

```typescript
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

--------------------------------

### Static Step Method Transformation

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Input and output examples for transforming static class methods marked with 'use step'.

```javascript
export class MyService {
  static async process(data) {
    "use step";
    return data.value * 2;
  }
}
```

```javascript
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
    static async process(data) {
        return data.value * 2;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(MyService.process, "step//./input//MyService.process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(MyService, "class//./input//MyService");
```

```javascript
/**__internal_workflows{"steps":{"input.js":{"MyService.process":{"stepId":"step//./input//MyService.process"}}},"classes":{"input.js":{"MyService":{"classId":"class//./input//MyService"}}}}*/;
export class MyService {
}
MyService.process = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./input//MyService.process");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(MyService, "class//./input//MyService");
```

--------------------------------

### Install World migration skill

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/upgrading-to-v5.mdx

Use the npx command to add the migration skill for upgrading a custom World from v4 to v5.

```bash
npx skills add https://github.com/vercel/workflow --skill migrating-world-v4-to-v5
```

--------------------------------

### Example Trace Output

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

A representation of a workflow trace showing out-of-order event log positions.

```text
# 8    +1.0m  wf   wait_completed   @6
# 7    +1.0m  ext    hook_received  @2   token="count:doc-29"
# 9    +1.0m  wf   step_created     @9   settle
```

--------------------------------

### Parameter destructuring and patterns

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Examples of supported function parameter patterns for workflow steps.

```javascript
async function({ a, b }) { "use step"; }
```

```javascript
async function([first, second]) { "use step"; }
```

```javascript
async function({ x = 10 }) { "use step"; }
```

```javascript
async function(a, ...rest) { "use step"; }
```

```javascript
async function({ user: { name } }) { "use step"; }
```

--------------------------------

### Run Development Server

Source: https://github.com/vercel/workflow/blob/main/workbench/sveltekit/README.md

Starts the Svelte development server to enable hot-reloading. Includes an option to automatically open the application in the default browser.

```shell
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

--------------------------------

### Static Workflow Method Transformation

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Input and output examples for transforming static class methods marked with 'use workflow'.

```javascript
export class JobRunner {
  static async runJob(jobId) {
    "use workflow";
    return await processJob(jobId);
  }
}
```

```javascript
/**__internal_workflows{"workflows":{"input.js":{"JobRunner.runJob":{"workflowId":"workflow//./input//JobRunner.runJob"}}}}*/;
export class JobRunner {
    static async runJob(jobId) {
        return await processJob(jobId);
    }
}
JobRunner.runJob.workflowId = "workflow//./input//JobRunner.runJob";
globalThis.__private_workflows.set("workflow//./input//JobRunner.runJob", JobRunner.runJob);
```

--------------------------------

### Install package via tarball URL

Source: https://github.com/vercel/workflow/blob/main/tarballs/README.md

Use this dependency format in package.json to install a specific package version from a Vercel deployment tarball.

```json
{
  "dependencies": {
    "workflow": "https://<deployment>.vercel.sh/workflow.tgz"
  }
}
```

--------------------------------

### Run Next.js Development Server

Source: https://github.com/vercel/workflow/blob/main/workbench/nextjs-turbopack/README.md

Commands to start the Next.js development server using different package managers like npm, yarn, pnpm, and bun. This allows for local development and testing of the application.

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

--------------------------------

### Next.js Workflow Development Commands

Source: https://github.com/vercel/workflow/blob/main/AGENTS.md

Commands for starting, building, and running a Next.js application with workflow support.

```bash
# Start Next.js dev server with workflow support
cd workbench/nextjs-turbopack && pnpm dev

# Build Next.js app with workflows
cd workbench/nextjs-turbopack && pnpm build

# Production server
cd workbench/nextjs-turbopack && pnpm start
```

--------------------------------

### Node.js Production Build and Execution

Source: https://github.com/vercel/workflow/blob/main/workbench/fastify/README.md

Compiles the application for a standard Node.js environment and starts the server using the generated output file. This is suitable for traditional server deployments.

```bash
npm run build
node .output/server/index.mjs
```

--------------------------------

### Start a Workflow

Source: https://github.com/vercel/workflow/blob/main/README.md

Trigger a workflow from server-side code such as an API route or Server Action.

```ts
import { start } from 'workflow/api';
import { onboardUser } from './workflows/onboard-user';

await start(onboardUser, ['hello@example.com']);
```

--------------------------------

### Simulation Event Stream Log

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

Example output showing the sequence of events and writer interactions during a simulation run.

```text
  0     +0ms  wf                run_created       approvalWorkflow input=<17B>
  1     +0ms  wf                run_started
  2     +0ms  wf                hook_created     hook_…KX  token="approval:doc-1"
  3     +0ms  wf                step_created     step_…KY  reserveInventory input=<58B>
  4     +0ms  wf                step_started     step_…KY  reserveInventory
        +0ms  wf                >> held "orchestrator -> step_started step=reserveInventory (committed)" at events.create:after
  5     +0ms  ext                 hook_received    hook_…KX  token="approval:doc-1" payload=<44B>
  6     +0ms  reserveInventory  step_completed   step_…KY  reserveInventory result=<22B>
  …
```

--------------------------------

### Generate Workflow Run Deep Links

Source: https://github.com/vercel/workflow/blob/main/skills/workflow/SKILL.md

Use the --url flag to output a dashboard link without opening a browser or starting a local server.

```bash
# Vercel run: prints the Vercel dashboard URL for the run
npx workflow inspect run <run_id> --backend vercel --project <project> --team <team> --url
npx workflow web <run_id> --backend vercel --project <project> --team <team> --env preview --url

# Local run: prints the local web UI deep link
npx workflow inspect run <run_id> --url

# Machine-readable: --url --json prints { "url": "..." } to stdout
npx workflow inspect run <run_id> --backend vercel --url --json
```

--------------------------------

### Configure SWC Plugin Module Specifier

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Example configuration for the plugin to use a specific module specifier for ID generation.

```json
{
  "mode": "step",
  "moduleSpecifier": "workflow/internal/builtins@4.0.0"
}
```

--------------------------------

### Sim World CI Summary Output

Source: https://github.com/vercel/workflow/blob/main/workbench/sim-world/README.md

Example of the output format generated by the simulation for CI pull request comments.

```text
## Sim World

Simulated world deterministic testing for races. [Traces](…)

▸ 🟢 world-sim scenario book — 0 fail of 41 total
```

--------------------------------

### Add WASM Build Target

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/README.md

Installs the wasm32-unknown-unknown target for Rust, necessary for building WebAssembly modules.

```bash
rustup target add wasm32-unknown-unknown
```

--------------------------------

### Dynamic import of step bundle

Source: https://github.com/vercel/workflow/blob/main/workbench/vitest/MOCKING.md

The workflow test setup loads the prebuilt step bundle using a dynamic import with @vite-ignore, which bypasses the Vitest transformation pipeline.

```typescript
const stepsModule = await import(/* @vite-ignore */ join(outDir, 'steps.mjs'));
```

--------------------------------

### Detect Mode Output

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Example of the JSON manifest comment emitted by the plugin in detect mode without modifying source code.

```javascript
/**__internal_workflows{"steps":{"input.js":{"fetchInventory":{"stepId":"step//./input//fetchInventory"}}},"workflows":{"input.js":{"placeOrder":{"workflowId":"workflow//./input//placeOrder"}}}}*/
// ... original source code unchanged ...
```

--------------------------------

### Serialization Error Log

Source: https://github.com/vercel/workflow/blob/main/workbench/python/README.md

Example of a SerializationError occurring when the SDK encounters an encrypted 'encr' format input it cannot read.

```text
SerializationError: the input of run wrun_... uses the 'encr' format,
                    which this SDK cannot read
```

--------------------------------

### Bootstrap Database via CLI

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md

Commands to initialize the database schema using the package's CLI tool across different package managers.

```bash
# npm
npx --package=@workflow/world-postgres bootstrap

# pnpm
pnpm dlx --package @workflow/world-postgres bootstrap

# Yarn
yarn dlx --package @workflow/world-postgres bootstrap

# Bun
bunx --package @workflow/world-postgres bootstrap
```

--------------------------------

### Initialize Workflow Workers in Next.js

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/HOW_IT_WORKS.md

Start the workflow workers within the Next.js instrumentation file to ensure they are active before request handling begins.

```ts
// instrumentation.ts

if (process.env.NEXT_RUNTIME !== "edge") {
  import("workflow/runtime").then(async ({ getWorld }) => {
    // start listening to the jobs.
    const world = await getWorld();
    await world.start?.();
  });
}
```

--------------------------------

### Trigger child workflows from within a workflow

Source: https://github.com/vercel/workflow/blob/main/skills/workflow/SKILL.md

Wrap the start function in a step function to trigger child workflows from inside an existing workflow.

```typescript
import { start } from "workflow/api";

// Wrap start() in a step function
async function triggerChild(data: string) {
  "use step";
  const run = await start(childWorkflow, [data]);
  return run.runId;
}

export async function parentWorkflow() {
  "use workflow";
  const childRunId = await triggerChild("some data");  // Fire-and-forget via step
  await sleep("1h");
}
```

--------------------------------

### Run database migration

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Execute the bootstrap command to create necessary database tables, ensuring the connection URL is configured.

```bash
npx --package=@workflow/world-postgres bootstrap
```

```bash
pnpm dlx --package @workflow/world-postgres bootstrap
```

```bash
yarn dlx --package @workflow/world-postgres bootstrap
```

```bash
bunx --package @workflow/world-postgres bootstrap
```

--------------------------------

### Define Workflow World Interface

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/evals/non-vercel-runtime-branch.md

Defines the interface for the workflow world, extending Storage, Queue, and Streamer capabilities with an optional start function.

```typescript
interface World extends Storage, Queue, Streamer {
  start?(): Promise<void>;
}
```

--------------------------------

### Build and run for Node.js

Source: https://github.com/vercel/workflow/blob/main/workbench/express/README.md

Compiles the project and executes the generated server entry point.

```sh
npm run build
node .output/server/index.mjs
```

--------------------------------

### Explicitly pin a workflow run to a region

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/vercel.mdx

Use the region option in the start function to specify where the workflow run's data is stored and dispatched from.

```typescript
import { start } from "workflow/api";
import { myWorkflow } from "@/workflows/my-workflow";

const run = await start(myWorkflow, [input], { region: "sfo1" });
```

--------------------------------

### Extend Module Resolution Paths

Source: https://github.com/vercel/workflow/blob/main/packages/docs-typecheck/README.md

Add new package or subpath resolutions to `compilerOptions.paths` in `src/type-checker.ts` to extend module resolution for docs examples.

```typescript
paths: {
  // existing mappings...
  '@workflow/new-package': [path.join(repoRoot, 'packages/new-package/dist/index')],
}
```

--------------------------------

### HTTP Request Error Log

Source: https://github.com/vercel/workflow/blob/main/workbench/python/README.md

Example of a failed HTTP request log showing a 302 redirect to an SSO page instead of the expected workflow-server response.

```text
HTTP Request: GET https://e2e.vercel-workflow.com/api/v2/runs/wrun_... "HTTP/1.1 302 Found"
  File ".../worlds/vercel.py", line 219, in _cbor_request
    result = resp.json()
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
cbor2.CBORDecodeEOF: premature end of stream
```

--------------------------------

### Trigger Workflow and Log Output

Source: https://github.com/vercel/workflow/blob/main/workbench/sveltekit/src/app.html

Initiates a workflow execution via an API call and logs the process. This is useful for starting background tasks or complex operations managed by the Workflow SDK.

```javascript
const outputEl = document.getElementById("output");
const { runId } = await fetchAndLog('/api/trigger?workflowFile=workflows/0_calc.ts&workflowFn=calc&args=2', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: "",
});
if (runId) {
  log('Getting workflow status with runId:', runId);
  await fetchAndLog(`/api/trigger?runId=${runId}`);
}
```

--------------------------------

### Private Member Elimination Example

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Demonstrates the transformation of a class containing private members and a 'use step' getter into a stripped version where unreferenced private members are removed.

```typescript
export class Run {
  static [WORKFLOW_SERIALIZE](instance) { return { id: instance.id }; }
  static [WORKFLOW_DESERIALIZE](data) { return new Run(data.id); }

  id: string;
  private encryptionKeyPromise: Promise<any> | null = null;

  private async getEncryptionKey() {
    if (!this.encryptionKeyPromise) {
      this.encryptionKeyPromise = importKey(this.id);
    }
    return this.encryptionKeyPromise;
  }

  constructor(id: string) { this.id = id; }

  get value(): Promise<any> {
    'use step';
    return this.getEncryptionKey().then(() => getWorld().get(this.id));
  }
}
```

```javascript
export class Run {
  static [WORKFLOW_SERIALIZE](instance) { return { id: instance.id }; }
  static [WORKFLOW_DESERIALIZE](data) { return new Run(data.id); }
  id;
  // private encryptionKeyPromise: ELIMINATED (only referenced by getEncryptionKey)
  // private getEncryptionKey(): ELIMINATED (only referenced by stripped getter)
  constructor(id) { this.id = id; }
}
// getter replaced with step proxy
var __step_Run$value = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step_id");
Object.defineProperty(Run.prototype, "value", {
  get() { return __step_Run$value.call(this); },
  configurable: true, enumerable: false
});
```

--------------------------------

### Build and Preview Production App

Source: https://github.com/vercel/workflow/blob/main/workbench/sveltekit/README.md

Compiles the application into a production-ready build and provides a command to preview the generated output locally.

```shell
npm run build

npm run preview
```

--------------------------------

### Define Custom World Interface

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/runtime-targets.md

This interface extends Queue, Streamer, and Storage, and includes an optional start method for background workers. Use this when implementing a custom World for self-hosted runtimes.

```typescript
interface World extends Queue, Streamer, Storage {
  start?(): Promise<void>;
}
```

--------------------------------

### Build @workflow/core

Source: https://github.com/vercel/workflow/blob/main/packages/core/scripts/README.md

Compile the serialization layer before running benchmarks.

```bash
pnpm --filter @workflow/core build
cd packages/core
```

--------------------------------

### Launch local observability UI

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/vercel.mdx

Command to use the local observability UI instead of the Vercel dashboard.

```bash
npx workflow web --backend vercel --localUi
```

--------------------------------

### Add pre-build scripts

Source: https://github.com/vercel/workflow/blob/main/packages/nest/README.md

Configure package.json scripts to regenerate configuration before building.

```json
{
  "scripts": {
    "prebuild": "npx @workflow/nest init --force",
    "build": "nest build"
  }
}
```

--------------------------------

### Execute Workflow CLI Commands

Source: https://github.com/vercel/workflow/blob/main/packages/nest/README.md

Use the CLI to initialize configurations, build bundles, or generate Vercel output.

```bash
# Generate .swcrc configuration
npx @workflow/nest init

# Force regenerate (overwrites existing)
npx @workflow/nest init --force

# Build workflow bundles for local dev
npx @workflow/nest build

# Emit the Vercel Build Output (.vercel/output); implied when VERCEL is set
npx @workflow/nest build --vercel

# Show help
npx @workflow/nest --help
```

--------------------------------

### Inspect and Manage Workflows via CLI

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Use these commands to set the database connection, list workflow runs, and launch the web interface.

```bash
# Set your database URL
export WORKFLOW_POSTGRES_URL="postgres://user:password@host:5432/database"

# List workflow runs
npx workflow inspect runs --backend @workflow/world-postgres

# Launch the web UI
npx workflow web --backend @workflow/world-postgres
```

--------------------------------

### Run All Documentation Tests

Source: https://github.com/vercel/workflow/blob/main/packages/docs-typecheck/README.md

Execute all documentation tests from the repository root or package directory.

```bash
pnpm test:docs
```

--------------------------------

### Initialize SWC configuration

Source: https://github.com/vercel/workflow/blob/main/packages/nest/README.md

Generate the .swcrc file and ensure it is ignored by version control.

```bash
npx @workflow/nest init
```

```bash
echo '/.swcrc' >> .gitignore
```

--------------------------------

### Build and deploy for Vercel

Source: https://github.com/vercel/workflow/blob/main/workbench/express/README.md

Configures the build for the Vercel preset and deploys the prebuilt output.

```sh
NITRO_PRESET=vercel npm run build
npx vercel --prebuilt
```

--------------------------------

### Build and Test Commands

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md

Commands to build the package and execute integration tests.

```bash
pnpm build
pnpm test
```

--------------------------------

### Configure environment variables

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Set the target world and database connection string in your .env file.

```bash
WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
WORKFLOW_POSTGRES_URL="postgres://user:password@host:5432/database"
```

--------------------------------

### Initialize Conformance Test Suite

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-world-v4-to-v5/SKILL.md

Use the conformance suite to validate the World implementation against expected behaviors. Ensure the target world path is correctly specified.

```ts
import { createTestSuite } from '@workflow/world-testing';

createTestSuite('@my-org/my-world'); // or a path to the built entrypoint
```

--------------------------------

### Deploy application to Vercel

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/vercel.mdx

Execute the deployment command to initiate the Vercel workflow backend configuration.

```bash
vercel deploy
```

--------------------------------

### Benchmark CPU cost

Source: https://github.com/vercel/workflow/blob/main/packages/core/scripts/README.md

Execute the script to measure serialization and deserialization performance impact.

```bash
node scripts/benchmark-compression-cpu.mjs
```

--------------------------------

### Create a new changeset

Source: https://github.com/vercel/workflow/blob/main/AGENTS.md

Run this command from the repository root to initiate the creation of a new changeset.

```bash
pnpm changeset add
```

--------------------------------

### CLI Commands

Source: https://github.com/vercel/workflow/blob/main/packages/nest/README.md

Command line interface for initializing and building workflow bundles.

```APIDOC
## CLI Commands

### npx @workflow/nest init
Generates the .swcrc configuration. Use `--force` to overwrite existing files.

### npx @workflow/nest build
Builds workflow bundles. 
- `--vercel`: Emit a Vercel Build Output API directory.
- `--dirs <dirs>`: Comma-separated source directories.
- `--entry <path>`: Vercel app entry module path.
- `--out-dir <dir>`: Output directory for local-dev bundles.
- `--module <type>`: SWC module type (es6 or commonjs).
```

--------------------------------

### Initialize Svelte Project

Source: https://github.com/vercel/workflow/blob/main/workbench/sveltekit/README.md

Creates a new Svelte project using the sv CLI. You can initialize in the current directory or specify a target folder name.

```shell
# create a new project in the current directory
npx sv create

# create a new project in my-app
npx sv create my-app
```

--------------------------------

### Execute workspace-level development commands

Source: https://github.com/vercel/workflow/blob/main/AGENTS.md

Standard commands for building, testing, and maintaining code quality across all packages.

```bash
# Build all packages
pnpm build

# Run tests across all packages  
pnpm test

# Run end-to-end tests
pnpm test:e2e

# Format code with Biome
pnpm format

# Lint with Biome
pnpm lint

# Typecheck TypeScript
pnpm typecheck

# Clean build artifacts
pnpm clean
```

--------------------------------

### Inspect and view local workflows

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/local.mdx

Commands to list recent workflow runs and launch the web interface for local development.

```bash
# List recent workflow runs
npx workflow inspect runs

# Launch the web UI
npx workflow web
```

--------------------------------

### List workflow runs and launch web UI

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/vercel.mdx

Commands to open the Vercel dashboard for inspecting workflow runs or launching the web interface.

```bash
# List workflow runs (opens Vercel dashboard)
npx workflow inspect runs --backend vercel

# Launch the web UI (opens Vercel dashboard)
npx workflow web --backend vercel
```

--------------------------------

### Project structure overview

Source: https://github.com/vercel/workflow/blob/main/workbench/vitest/README.md

Directory layout for the Vitest workbench, including workflow definitions and test files.

```text
workbench/vitest/
├── workflows/
│   ├── simple.ts          # Basic workflow with arithmetic steps
│   ├── sleeping.ts        # Workflows with sleep() calls
│   ├── hooks.ts           # Workflow with createHook() for external data
│   └── webhook.ts         # Workflow with createWebhook() for HTTP payloads
├── test/
│   └── workflow.test.ts   # Integration tests for all workflow types
├── vitest.config.ts       # Vitest config with workflow() plugin
├── MOCKING.md             # Analysis of mocking limitations
└── package.json
```

--------------------------------

### Instance Method Step Transformation

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Shows how class instance methods using 'use step' are transformed when custom serialization is provided.

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';

export class Counter {
  static [WORKFLOW_SERIALIZE](instance) {
    return { value: instance.value };
  }
  static [WORKFLOW_DESERIALIZE](data) {
    return new Counter(data.value);
  }
  constructor(value) {
    this.value = value;
  }
  async add(amount) {
    'use step';
    return this.value + amount;
  }
}
```

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from '@workflow/serde';
/**__internal_workflows{"steps":{"input.js":{"Counter#add":{"stepId":"step//./input//Counter#add"}}},"classes":{"input.js":{"Counter":{"classId":"class//./input//Counter"}}}}*/;
export class Counter {
    static [WORKFLOW_SERIALIZE](instance) {
        return { value: instance.value };
    }
    static [WORKFLOW_DESERIALIZE](data) {
        return new Counter(data.value);
    }
    constructor(value) {
        this.value = value;
    }
    async add(amount) {
        return this.value + amount;
    }
}
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(Counter.prototype["add"], "step//./input//Counter#add");
(function(__wf_cls, __wf_id) {
    var __wf_sym = Symbol.for("workflow-class-registry"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_cls);
    Object.defineProperty(__wf_cls, "classId", { value: __wf_id, writable: false, enumerable: false, configurable: false });
})(Counter, "class//./input//Counter");
```

--------------------------------

### Configure Detect Mode

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Use this configuration to enable the lightweight, non-transforming detect mode for build discovery.

```json
{
  "mode": "detect",
  "moduleSpecifier": null
}
```

--------------------------------

### Vercel Production Build and Deployment

Source: https://github.com/vercel/workflow/blob/main/workbench/fastify/README.md

Configures the build process for Vercel deployment and executes the deployment using the prebuilt output. This ensures the application is optimized for serverless execution.

```bash
NITRO_PRESET=vercel npm run build
npx vercel --prebuilt
```

--------------------------------

### Replace createLocalWorld with createWorld

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-workflow-v4-to-v5/SKILL.md

First-party World packages now use a unified createWorld factory.

```ts
// v4
import { createLocalWorld } from '@workflow/world-local';
const world = createLocalWorld({ dataDir });

// v5
import { createWorld } from '@workflow/world-local';
const world = createWorld({ dataDir });
```

--------------------------------

### Run compression-off baseline benchmark

Source: https://github.com/vercel/workflow/blob/main/packages/core/scripts/README.md

Run the benchmark suite with compression disabled to establish a performance baseline.

```bash
# Compression-off baseline
WORKFLOW_DISABLE_COMPRESSION=1 pnpm dev &          # in the workbench
# From repo root
WORKFLOW_DISABLE_COMPRESSION=1 \
  DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack pnpm bench
mv bench-results-nextjs-turbopack-local.json bench-results-...-off.json
```

--------------------------------

### Configure Self-Hosted Runtime World

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/aws-step-functions.md

Defines the World interface and the startup function required for managing storage, queueing, and streaming in self-hosted environments.

```typescript
interface World extends Queue, Streamer, Storage {
  start?(): Promise<void>;
}
```

```typescript
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

--------------------------------

### Execute a Scenario

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

Build the simulation bundle and run the scenario using the workflow handler.

```typescript
import {
  loadFlowHandler,
  renderScenario,
  runScenario,
  type ScenarioSpec,
} from '@workflow/world-sim';
// Separate entry on purpose: this one reaches SWC and esbuild through
// `@workflow/builders`, and playing a scenario should not drag a compiler into
// the module graph.
import { buildSimBundle } from '@workflow/world-sim/build';

declare const spec: ScenarioSpec; // the one above

const bundle = await buildSimBundle({ cwd: process.cwd(), dirs: ['workflows'] });
const handler = await loadFlowHandler(bundle.flowBundlePath);

const result = await runScenario(spec, {
  handler,
  workflowIds: bundle.workflowIds,
});
console.log(renderScenario(result));
```

--------------------------------

### Initialize local world configuration

Source: https://github.com/vercel/workflow/blob/main/packages/world-local/README.md

Use createWorld to instantiate the local workflow backend with a custom directory for data storage.

```ts
import { createWorld } from '@workflow/world-local';

const world = createWorld({
  dataDir: './custom-workflow-data',
});
```

--------------------------------

### Disposable resource handling with 'using'

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Demonstrates how the plugin handles TypeScript 'using' declarations before and after transformation.

```typescript
async function testStep() {
  'use step';
  using writer = getWriter(getWritable());
  await writer.write('Hello, world!');
}
```

```javascript
async function testStep() {
  const env = {
    stack: [],
    error: void 0,
    hasError: false
  };
  try {
    "use step";  // Directive is now inside try block
    const writer = _ts_add_disposable_resource(env, getWriter(getWritable()), false);
    await writer.write("Hello, world!");
  } catch (e) {
    env.error = e;
    env.hasError = true;
  } finally {
    _ts_dispose_resources(env);
  }
}
```

--------------------------------

### sim.beginHookDelivery(token, payload)

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

Begins an external hook delivery and returns a commit function.

```APIDOC
## sim.beginHookDelivery(token, payload)

### Description
Begin an external hook delivery and return `commit()`, which writes it at the log tail.

### Parameters
- **token** (string) - Required - The delivery token.
- **payload** (any) - Required - The hook payload.
```

--------------------------------

### Define migration prompt

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/SKILL.md

Use this prompt structure to request a migration of an Inngest workflow to the Workflow SDK.

```text
Migrate this Inngest workflow to the Workflow SDK.
It uses step.waitForEvent() with a timeout and step.realtime.publish().
```

--------------------------------

### Class Expression with Step Methods

Source: https://github.com/vercel/workflow/blob/main/packages/swc-plugin-workflow/spec.md

Shows how step methods and class registration use the binding name for identification.

```javascript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

var LanguageModel = class _LanguageModel {
  constructor(modelId) { this.modelId = modelId; }
  static [WORKFLOW_SERIALIZE](inst) { return { modelId: inst.modelId }; }
  static [WORKFLOW_DESERIALIZE](data) { return new _LanguageModel(data.modelId); }
  async doStream(prompt) { "use step"; return { stream: prompt }; }
  static async generate(input) { "use step"; return { result: input }; }
};
```

```javascript
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(LanguageModel.generate, "step//./input//LanguageModel.generate");
(function(__wf_fn, __wf_id) {
    var __wf_sym = Symbol.for("@workflow/core//registeredSteps"), __wf_reg = globalThis[__wf_sym] || (globalThis[__wf_sym] = new Map());
    __wf_reg.set(__wf_id, __wf_fn);
    __wf_fn.stepId = __wf_id;
})(LanguageModel.prototype["doStream"], "step//./input//LanguageModel#doStream");
(function(__wf_cls, __wf_id) { /* ... */ })(LanguageModel, "class//./input//LanguageModel");
```

--------------------------------

### Core package testing commands

Source: https://github.com/vercel/workflow/blob/main/CLAUDE.md

Commands for testing core functionality and running E2E tests against a local development server.

```bash
# Test core functionality
cd packages/core && pnpm test

# Test specific file
cd packages/core && pnpm vitest run src/[filename].test.ts

# Run E2E tests (requires environment variables and running dev server)
# Note: Use nextjs-turbopack for local e2e testing (not example app - it has no dev server)

# Step 1: Start the dev server in background
# NOTE: WORKFLOW_PUBLIC_MANIFEST=1 is required for e2e tests to access the workflow manifest
cd workbench/nextjs-turbopack && WORKFLOW_PUBLIC_MANIFEST=1 pnpm dev > /tmp/nextjs-dev.log 2>&1 &

# Step 2: Wait for server to be ready (usually 15-20 seconds)
sleep 15

# Step 3: Run the e2e tests from the project root
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts

# Step 4: Stop the dev server when done
pkill -f "pnpm dev"

# To run specific tests, use the -t flag:
DEPLOYMENT_URL="http://localhost:3000" APP_NAME="nextjs-turbopack" pnpm vitest run packages/core/e2e/e2e.test.ts -t "sleeping"
```

--------------------------------

### sim.park(match, label?)

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

Holds the next matching call, regardless of which writer makes it.

```APIDOC
## sim.park(match, label?)

### Description
Hold the next matching call, whoever makes it.

### Parameters
- **match** (object) - Required - A raw match object containing fields like call, phase, eventType, stepName, etc.
- **label** (string) - Optional - A label for the park operation.
```

--------------------------------

### Programmatic World Configuration

Source: https://github.com/vercel/workflow/blob/main/docs/content/worlds/v5/postgres.mdx

Configure the PostgreSQL world using the createWorld function. Options provided here take precedence over environment variables.

```typescript
import { createWorld } from "@workflow/world-postgres";

export default createWorld({
  connectionString:
    process.env.WORKFLOW_POSTGRES_URL ?? process.env.DATABASE_URL!,
  jobPrefix: "myapp_",
  namespace: "myapp",
  queueConcurrency: 50,
  maxPoolSize: 52, // overrides WORKFLOW_POSTGRES_MAX_POOL_SIZE
  streamFlushIntervalMs: 10,
});
```

--------------------------------

### Create Manual Response Webhook

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/shared-patterns.md

Use `createWebhook({ respondWith: 'manual' })` when the external system requires a custom HTTP response. The `request.respondWith()` operation must be called within a step context.

```typescript
import { createWebhook, type RequestWithResponse } from 'workflow';

type VerificationCallback = {
  approved: boolean;
  reviewer?: string;
};

export async function verificationWorkflow(documentId: string) {
  'use workflow';

  using webhook = createWebhook({ respondWith: 'manual' });

  await submitForVerification(documentId, webhook.url);
  const request = await webhook;
  const payload = (await request.json()) as VerificationCallback;

  await acknowledgeVerification(request, payload.approved);

  return payload.approved
    ? { status: 'verified' as const, reviewer: payload.reviewer }
    : { status: 'rejected' as const, reviewer: payload.reviewer };
}

async function submitForVerification(
  documentId: string,
  callbackUrl: string,
): Promise<void> {
  'use step';

  await fetch(process.env.VENDOR_VERIFY_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, callbackUrl }),
  });
}

async function acknowledgeVerification(
  request: RequestWithResponse,
  approved: boolean,
): Promise<void> {
  'use step';

  await request.respondWith(
    Response.json({ ok: true, approved }),
  );
}
```

--------------------------------

### Inspect Workflow Runs

Source: https://github.com/vercel/workflow/blob/main/workbench/python/README.md

Use the workflow CLI to inspect data generated by the Python workbench.

```bash
cd workbench/python && node ./node_modules/workflow/bin/run.js inspect --json runs
```

--------------------------------

### Run Vitest tests

Source: https://github.com/vercel/workflow/blob/main/workbench/vitest/README.md

Execute the test suite using the package manager.

```bash
pnpm test
```

--------------------------------

### Run simulation scenarios via CLI

Source: https://github.com/vercel/workflow/blob/main/workbench/sim-world/README.md

Execute simulation scenarios using pnpm commands, with support for filtering by ID or name.

```bash
pnpm sim                             # play every scenario, print every event stream
pnpm sim hook                        # only scenarios whose id or name contains "hook"
pnpm sim in-flight-after-decision    # one scenario, by id
```

--------------------------------

### sim.writer.step(name)

Source: https://github.com/vercel/workflow/blob/main/packages/world-sim/README.md

Returns a writer handle for a specific step by name, allowing control over step-specific events.

```APIDOC
## sim.writer.step(name)

### Description
Returns a writer handle for a step body identified by its name.

### Parameters
- **name** (string) - Required - The name of the step to retrieve a writer for.

### Returns
- **Writer** - A handle representing the step writer.
```

--------------------------------

### Create PostgreSQL World Programmatically

Source: https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md

Initialize the world directly in code using connection strings or an existing pg.Pool.

```typescript
import { createWorld } from "@workflow/world-postgres";

const world = createWorld({
  connectionString: "postgres://username:password@localhost:5432/database",
  jobPrefix: "myapp", // optional
  queueConcurrency: 50, // optional
  maxPoolSize: 10, // optional, overrides WORKFLOW_POSTGRES_MAX_POOL_SIZE when `pool` is omitted
});

// Or pass an existing pg.Pool (shared with your app Drizzle, etc.); `world.close()` will not end it.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const worldFromPool = createWorld({ pool });
```

--------------------------------

### Benchmark storage size

Source: https://github.com/vercel/workflow/blob/main/packages/core/scripts/README.md

Execute the script to measure bytes saved by compression across different workloads.

```bash
node scripts/benchmark-compression-size.mjs
```

--------------------------------

### Define the Migration Plan structure

Source: https://github.com/vercel/workflow/blob/main/skills/migrating-to-workflow-sdk/references/resume-routing.md

Use this template to outline the migration strategy, including source platform, selected route keys, and specific code obligations.

```markdown
## Migration Plan
- Source: [Temporal | Inngest | AWS Step Functions | Trigger.dev]
- Route keys: [comma-separated keys]
- Why these route keys:
  - [route key]: [reason from the prompt]
- Required code obligations:
  - [obligation 1]
  - [obligation 2]
```
