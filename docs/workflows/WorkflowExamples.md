### Clone Repository and Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/rag-agent/README.md

Use this command to clone the example repository and install the necessary project dependencies.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/rag-agent
pnpm install
```

--------------------------------

### Run Development Server with npm, pnpm, or bun

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Start the local development server to test the actor example. Access the application via http://localhost:3000 in your browser.

```bash
npm run dev
# or
pnpm dev
# or
bun dev
```

--------------------------------

### Start Development Server (Bash)

Source: https://github.com/vercel/workflow-examples/blob/main/tanstack-start/README.md

Start the local development server for the TanStack Start project.

```bash
pnpm dev
```

--------------------------------

### Clone Nuxt Workflow Example and Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/nuxt/README.md

Clone the Nuxt workflow example repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/nuxt
pnpm install
```

--------------------------------

### Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/ffmpeg-processing
pnpm install
```

--------------------------------

### Start Development Server

Source: https://github.com/vercel/workflow-examples/blob/main/nitro/README.md

Run this command to start the Nitro development server locally.

```bash
pnpm dev
```

--------------------------------

### Clone and Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/postgres/README.md

Clone the repository and install project dependencies using bun.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/postgres
bun install
```

--------------------------------

### Start Development Server with Bun

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Starts the development server using the Bun runtime. The server will be accessible at http://localhost:3152.

```bash
bun run dev
```

--------------------------------

### Install Dependencies with pnpm

Source: https://github.com/vercel/workflow-examples/blob/main/sveltekit/README.md

Clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/sveltekit
pnpm install
```

--------------------------------

### API Request Example

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Example of how to use curl to send an audio file to the /convert endpoint for compression.

```bash
curl -X POST -F "file=@podcast.wav;type=audio/wav" -H "Expect:" http://localhost:3000/convert --output podcast.m4a
```

--------------------------------

### Clone and Install Dependencies with PNPM

Source: https://github.com/vercel/workflow-examples/blob/main/astro/README.md

Clone the repository and install project dependencies using PNPM. Ensure you have PNPM installed globally.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/astro
pnpm install
```

--------------------------------

### Clone and Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/flight-booking-app/README.md

Clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/flight-booking-app
pnpm install
```

--------------------------------

### Start Workflow Programmatically

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Demonstrates how to start a workflow function programmatically using the 'start' API from the 'workflow/api' module. Requires importing the workflow function and its arguments.

```typescript
import { start } from "workflow/api";
import { handleUserSignup } from "./workflows/user-signup.js";

const run = await start(handleUserSignup, [email]);
console.log(run.runId);
```

--------------------------------

### Install Dependencies with pnpm

Source: https://github.com/vercel/workflow-examples/blob/main/vite/README.md

Use this command to install project dependencies using pnpm. Ensure pnpm is installed globally.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/vite
pnpm install
```

--------------------------------

### Start Development Server

Source: https://github.com/vercel/workflow-examples/blob/main/postgres/README.md

Initiate the Next.js development server. The `instrumentation.ts` file is used to start the Postgres world worker upon server boot.

```bash
bun dev
```

--------------------------------

### Install Dependencies with pnpm

Source: https://github.com/vercel/workflow-examples/blob/main/nitro/README.md

Use this command to clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/nitro
pnpm install
```

--------------------------------

### Install Dependencies with Bun

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Installs project dependencies using the Bun package manager.

```bash
bun install
```

--------------------------------

### Install Dependencies with pnpm

Source: https://github.com/vercel/workflow-examples/blob/main/nextjs/README.md

Use this command to clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/nextjs
pnpm install
```

--------------------------------

### Clone Repository and Install Dependencies

Source: https://github.com/vercel/workflow-examples/blob/main/ai-sdk-workflow-patterns/README.md

Clone the project repository and install the necessary Node.js dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/ai-sdk-workflow-patterns
pnpm install
```

--------------------------------

### Clone and Install Hono Project

Source: https://github.com/vercel/workflow-examples/blob/main/hono/README.md

Clone the repository and install project dependencies using pnpm.

```bash
git clone https://github.com/vercel/workflow-examples
cd workflow-examples/hono
pnpm install
```

--------------------------------

### Run Database Migration

Source: https://github.com/vercel/workflow-examples/blob/main/postgres/README.md

Execute the database setup command to create or update Workflow tables. Run this command again after upgrading `@workflow/world-postgres` to keep the database schema synchronized.

```bash
bun run migrate
```

--------------------------------

### Install Dependencies with npm, pnpm, or bun

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Install project dependencies using your preferred package manager. This step is required before running the development server.

```bash
npm install
# or
pnpm install
# or
bun install
```

--------------------------------

### Bun Server with WebSockets and Routes

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/CLAUDE.md

Example of a Bun server handling HTTP requests, including dynamic routes and WebSocket connections. Enable hot module replacement and console logging for development.

```typescript
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

--------------------------------

### Start New Actor

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Initiates a new actor instance with specified initial state.

```APIDOC
## POST /api/actor

### Description
Starts a new actor instance.

### Method
POST

### Endpoint
/api/actor

### Request Body
- **initialState** (object) - Required - The initial state for the actor.
  - **count** (number) - The initial count value.
  - **lastUpdated** (string) - The timestamp of the last update.
  - **history** (array) - An array to log event history.

### Request Example
```json
{
  "initialState": {
    "count": 0,
    "lastUpdated": "2024-01-01T00:00:00.000Z",
    "history": []
  }
}
```

### Response
#### Success Response (200)
- **success** (boolean) - Indicates if the actor started successfully.
- **actorId** (string) - The unique identifier for the newly created actor.
- **message** (string) - A confirmation message.

#### Response Example
```json
{
  "success": true,
  "actorId": "run_abc123...",
  "message": "Actor started successfully"
}
```
```

--------------------------------

### Trigger User Signup Workflow

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Initiates the user signup workflow by making a GET request to the local server. Expects a JSON response containing the workflow run ID.

```bash
curl http://localhost:3152
```

--------------------------------

### Install Dependencies - Birthday Card Generator

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Installs project dependencies using pnpm. It's recommended to use pnpm for this project.

```bash
pnpm install
```

--------------------------------

### Start New Actor Instance Response Body

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

JSON response upon successfully starting a new actor instance. Provides a success status, actor ID, and a confirmation message.

```json
{
  "success": true,
  "actorId": "run_abc123...",
  "message": "Actor started successfully"
}
```

--------------------------------

### Bun Test Example

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/CLAUDE.md

A basic test case using Bun's built-in testing framework. Ensure tests are in files ending with .test.ts or .spec.ts.

```typescript
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

--------------------------------

### Start New Actor Instance Request Body

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

JSON payload for initiating a new actor instance. Includes the initial state for the actor.

```json
{
  "initialState": {
    "count": 0,
    "lastUpdated": "2024-01-01T00:00:00.000Z",
    "history": []
  }
}
```

--------------------------------

### Clone Repository - Birthday Card Generator

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Use this command to clone the project repository locally. Ensure you have Git installed.

```bash
git clone https://github.com/vercel/workflow-examples.git
cd workflow-examples/birthday-card-generator
```

--------------------------------

### Get Actor State

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Retrieves the current state of a specific actor instance.

```APIDOC
## GET /api/actor/[actorId]/state

### Description
Gets the current state of an actor (placeholder implementation).

### Method
GET

### Endpoint
/api/actor/[actorId]/state

### Parameters
#### Path Parameters
- **actorId** (string) - Required - The ID of the actor whose state to retrieve.

### Response
#### Success Response (200)
- **state** (object) - The current state of the actor.
  - **count** (number) - The current count value.
  - **lastUpdated** (string) - The timestamp of the last update.
  - **history** (array) - An array of past events.

#### Response Example
```json
{
  "state": {
    "count": 10,
    "lastUpdated": "2024-01-01T10:30:00.000Z",
    "history": [
      {"type": "increment", "amount": 5, "timestamp": "2024-01-01T10:00:00.000Z"},
      {"type": "increment", "amount": 5, "timestamp": "2024-01-01T10:30:00.000Z"}
    ]
  }
}
```
```

--------------------------------

### Create and Configure .env.local

Source: https://github.com/vercel/workflow-examples/blob/main/flight-booking-app/README.md

Create a .env.local file and add your Vercel AI Gateway API key.

```bash
touch .env.local
AI_GATEWAY_API_KEY=your_api_key_here
```

--------------------------------

### Configure Environment Variables

Source: https://github.com/vercel/workflow-examples/blob/main/rag-agent/README.md

Add your Vercel AI Gateway API key and PostgreSQL database URL to the .env.local file.

```bash
AI_GATEWAY_API_KEY=your_api_key_here
DATABASE_URL=your_database_url_here
```

--------------------------------

### Create Database Schema

Source: https://github.com/vercel/workflow-examples/blob/main/flight-booking-app/README.md

Execute the command to set up the database schema for the PostgreSQL World.

```bash
pnpm exec workflow-postgres-setup
```

--------------------------------

### Run Database Migrations

Source: https://github.com/vercel/workflow-examples/blob/main/rag-agent/README.md

Execute this command to apply database migrations for the project.

```bash
pnpm db:migrate
```

--------------------------------

### Create .env.local File

Source: https://github.com/vercel/workflow-examples/blob/main/ai-sdk-workflow-patterns/README.md

Create a local environment file to store sensitive credentials like API keys.

```bash
touch .env.local
```

--------------------------------

### HTML Import with React Frontend

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/CLAUDE.md

Demonstrates importing an HTML file that includes a React component and CSS. Bun automatically transpiles and bundles these assets.

```html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

--------------------------------

### Configure PostgreSQL Environment Variables

Source: https://github.com/vercel/workflow-examples/blob/main/flight-booking-app/README.md

Set up environment variables for PostgreSQL World, including database URL and worker concurrency.

```bash
WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
WORKFLOW_POSTGRES_URL="postgres://postgres:password@db.yourdb.co:5432/postgres"
WORKFLOW_POSTGRES_JOB_PREFIX="workflow_"
WORKFLOW_POSTGRES_WORKER_CONCURRENCY=10
```

--------------------------------

### Invoke Workflow with Curl (Bash)

Source: https://github.com/vercel/workflow-examples/blob/main/tanstack-start/README.md

Invoke the signup workflow by sending a POST request with a JSON payload to the local development server.

```bash
curl -X POST --json '{"email":"hello@example.com"}' http://localhost:3000/api/signup
```

--------------------------------

### Build for Production - Birthday Card Generator

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Builds the application for production deployment.

```bash
pnpm build
```

--------------------------------

### POST /convert - Audio Compression Endpoint

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

This endpoint handles the audio compression workflow. It accepts an audio file via multipart/form-data, processes it using FFmpeg within a Vercel Sandbox, and returns the compressed audio.

```APIDOC
## POST /convert

### Description
Compresses an uploaded audio file using FFmpeg within a workflow.

### Method
POST

### Endpoint
/convert

### Parameters
#### Path Parameters
None

#### Query Parameters
None

#### Request Body
- **file** (file) - Required - The audio file to be compressed. Accepted formats: WAV, MP3, OGG, FLAC, AAC, M4A.

### Request Example
```bash
curl -X POST -F "file=@input.wav;type=audio/wav" -H "Expect:" http://localhost:3000/convert --output output.m4a
```

### Response
#### Success Response (200)
- **Content-Type**: audio/mp4
- **Body**: Compressed audio file (M4A/AAC at 128kbps)

#### Response Example
(Binary audio data stream)
```

--------------------------------

### Add Vercel AI Gateway API Key

Source: https://github.com/vercel/workflow-examples/blob/main/ai-sdk-workflow-patterns/README.md

Configure your Vercel AI Gateway API key in the .env.local file for authentication.

```bash
AI_GATEWAY_API_KEY=your_api_key_here
```

--------------------------------

### Link Vercel Project and Pull Environment Variables

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Links your local project to a Vercel project and pulls necessary environment variables. This is crucial for local development, especially for AI Gateway authentication.

```bash
vc link --project birthday-card-generator --scope vercel-labs
vc env pull
```

--------------------------------

### Project Structure Overview

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Overview of the project's directory structure, highlighting the Express app, workflow orchestration, and individual workflow steps.

```tree
ffmpeg-processing/
├── src/
│   ├── index.ts                          # Express app with /convert route
│   └── workflows/
│       └── audio-convert/
│           ├── index.ts                  # Main workflow orchestration
│           └── steps/                    # Individual workflow steps
│               ├── create-sandbox.ts
│               ├── setup-ffmpeg.ts
│               ├── transcode.ts
│               ├── stream-output.ts
│               └── stop-sandbox.ts
t├── nitro.config.ts                       # Nitro configuration with workflow module
├── package.json
├── tsconfig.json
└── README.md
```

--------------------------------

### User Signup Workflow Definition

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Defines a user signup workflow using the 'use workflow' directive. This workflow creates a user, sends welcome and onboarding emails, and returns user status.

```typescript
export async function handleUserSignup(email: string) {
  "use workflow";

  const user = await createUser(email);
  await sendWelcomeEmail(user);
  await sendOnboardingEmail(user);

  return { userId: user.id, status: "onboarded" };
}
```

--------------------------------

### Test Audio Compression API

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Use curl to send a POST request with a WAV audio file to the /convert endpoint and save the compressed output.

```bash
curl -X POST -F "file=@input.wav;type=audio/wav" -H "Expect:" http://localhost:3000/convert --output output.m4a
```

--------------------------------

### Link Vercel Project

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Link the local project to your Vercel project for deployment and environment variable management.

```bash
npx vercel link
```

--------------------------------

### Pull Environment Variables for Local Development

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Fetches environment variables from your linked Vercel project. This is essential for local development as it provides `VERCEL_OIDC_TOKEN` for AI Gateway authentication.

```bash
vc env pull
```

--------------------------------

### Inspect Workflow Runs

Source: https://github.com/vercel/workflow-examples/blob/main/postgres/README.md

Use the Workflow CLI to inspect stored runs, specifying the Postgres backend.

```bash
bunx workflow inspect runs --backend @workflow/world-postgres
```

--------------------------------

### Fetch VERCEL_OIDC_TOKEN

Source: https://github.com/vercel/workflow-examples/blob/main/ffmpeg-processing/README.md

Fetch the VERCEL_OIDC_TOKEN, which is required by the workflow runtime for `@vercel/sandbox`. This is automatically injected when running in Vercel Sandbox.

```bash
npx vercel env pull
```

--------------------------------

### Set Postgres Environment Variables

Source: https://github.com/vercel/workflow-examples/blob/main/postgres/README.md

Configure environment variables for the Postgres world, specifying the target world and the PostgreSQL connection URL.

```bash
export WORKFLOW_TARGET_WORLD="@workflow/world-postgres"
export WORKFLOW_POSTGRES_URL="postgresql://<username>:<password>@<host>:<port>/<database>"
```

--------------------------------

### Running Bun Server

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/CLAUDE.md

Command to run the Bun server with hot module replacement enabled. This command will automatically reload the server when code changes are detected.

```sh
bun --hot ./index.ts
```

--------------------------------

### Inspect Workflow Runs (Bash)

Source: https://github.com/vercel/workflow-examples/blob/main/tanstack-start/README.md

Inspect the runs of the workflow using the Workflow DevKit CLI.

```bash
pnpm exec workflow inspect runs
```

--------------------------------

### Format Code - Birthday Card Generator

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Formats the project code using Biome for consistent styling.

```bash
pnpm format
```

--------------------------------

### Sequence Diagram for Birthday Card Generation

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Illustrates the flow of a birthday card generation request from user input to AI-generated image and message, highlighting interactions between the Next.js app, Vercel Workflow, and AI models via AI Gateway.

```mermaid
sequenceDiagram
    participant User
    participant App as Next.js App
    participant Workflow as Vercel Workflow
    participant Gemini as Google Gemini 2.5
    participant GPT as GPT-5-nano

    User->>App: Enter prompt
    App->>Workflow: POST /api/generate

    Note over Workflow: Start Workflow

    Workflow->>Gemini: Generate Image (Step 1)
    Note over Gemini: Via AI Gateway<br/>Automatic retries
    Gemini-->>Workflow: Birthday Card Image

    Workflow->>GPT: Generate Message (Step 2)
    Note over GPT: Via AI Gateway<br/>Automatic retries
    GPT-->>Workflow: Birthday Message Text

    Workflow-->>App: { image, text }
    App-->>User: Display Results
```

--------------------------------

### React Frontend Component

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/CLAUDE.md

A simple React component that renders a heading and imports CSS. This file can be directly imported into an HTML file for Bun to process.

```tsx
import React from "react";

// import .css files directly and it works
import './index.css';

import { createRoot } from "react-dom/client";

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

--------------------------------

### Invoke Workflow API with Curl

Source: https://github.com/vercel/workflow-examples/blob/main/astro/README.md

Invoke the signup API endpoint of the Astro application using curl. This sends a POST request with a JSON payload to the local development server.

```bash
curl -X POST --json '{"email":"hello@example.com"}' http://localhost:4321/api/signup
```

--------------------------------

### Initialize Workflow Workers in Next.js

Source: https://github.com/vercel/workflow-examples/blob/main/flight-booking-app/README.md

Register Workflow workers in your Next.js application's instrumentation.ts file to handle workflow state persistence with PostgreSQL.

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    console.log("Starting workflow workers...");
    import("workflow/runtime").then(async ({ getWorld }) => {
      console.log("Starting Postgres World...");
      await getWorld().start?.();
    });
    console.log("Workflow workers started!");
  }
}
```

--------------------------------

### Workflow Step Definition

Source: https://github.com/vercel/workflow-examples/blob/main/custom-adapter/README.md

Defines an individual workflow step for creating a user using the 'use step' directive. This function generates a unique user ID and returns user details.

```typescript
async function createUser(email: string) {
  "use step";

  return { id: crypto.randomUUID(), email };
}
```

--------------------------------

### Run Linting Checks - Birthday Card Generator

Source: https://github.com/vercel/workflow-examples/blob/main/birthday-card-generator/README.md

Executes linting checks to ensure code quality and consistency.

```bash
pnpm check
```

--------------------------------

### Invoke Workflow with curl

Source: https://github.com/vercel/workflow-examples/blob/main/nitro/README.md

This command demonstrates how to invoke the Nitro workflow API endpoint using curl with a JSON payload.

```bash
curl -X POST --json '{"email":"hello@example.com"}' http://localhost:3000/api/signup
```

--------------------------------

### Send Event to Actor Response Body

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

JSON response after successfully sending an event to an actor. Includes a success status, the run ID, and a confirmation message.

```json
{
  "success": true,
  "runId": "run_abc123...",
  "message": "Event sent to actor"
}
```

--------------------------------

### Send Event to Actor

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Sends an event to a specific actor instance for processing.

```APIDOC
## POST /api/actor/[actorId]/event

### Description
Sends an event to an actor instance.

### Method
POST

### Endpoint
/api/actor/[actorId]/event

### Parameters
#### Path Parameters
- **actorId** (string) - Required - The ID of the actor to send the event to.

### Request Body
- **event** (object) - Required - The event payload to send to the actor.
  - **type** (string) - The type of event (e.g., "increment", "decrement", "reset").
  - **amount** (number) - Optional - The amount to increment or decrement by (used with increment/decrement events).

### Request Example
```json
{
  "event": {
    "type": "increment",
    "amount": 5
  }
}
```

### Response
#### Success Response (200)
- **success** (boolean) - Indicates if the event was sent successfully.
- **runId** (string) - The ID of the workflow run that processed the event.
- **message** (string) - A confirmation message.

#### Response Example
```json
{
  "success": true,
  "runId": "run_abc123...",
  "message": "Event sent to actor"
}
```
```

--------------------------------

### Define and Use Hook as Async Iterator in TypeScript

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

Define a hook using defineHook for type safety and use it as an async iterator to process events sequentially within a workflow. The hook should be created outside the loop for efficiency.

```typescript
const counterActorHook = defineHook<CounterEvent>();

const receiveEvent = counterActorHook.create({
  token: `counter_actor:${actorId}`,
});

for await (const event of receiveEvent) {
  const state = await getState(actorId);
  const newState = await computeNewState(state, event);
  await setState(actorId, newState);
}
```

--------------------------------

### Send Event to Actor Request Body

Source: https://github.com/vercel/workflow-examples/blob/main/actors/README.md

JSON payload for sending an event to a specific actor instance. The 'event' object details the type and any associated data.

```json
{
  "event": {
    "type": "increment",
    "amount": 5
  }
}
```
