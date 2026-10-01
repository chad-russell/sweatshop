import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon; keep it out of the bundler. The
  // harness packages run in machine workflow steps (0009) and must load
  // through plain Node resolution: harness-pi pulls pi-mcp-adapter (raw
  // .ts exports Turbopack cannot type), and harness-claude-code loads
  // package-relative bridge assets via import.meta.url (0006).
  serverExternalPackages: [
    "better-sqlite3",
    "@ai-sdk/harness",
    "@ai-sdk/harness-pi",
    "@ai-sdk/harness-claude-code",
    "@ai-sdk/workflow-harness",
    "@earendil-works/pi-coding-agent",
  ],
  // Next dev 403-blocks /_next/* assets whose Origin/Referer host isn't
  // allowlisted — the app HTML loads but no JS hydrates, so forms fall
  // back to native GET submits. Allow the hosts we reach the dev server
  // from (localhost is allowed by default; these are bee's Nebula and
  // LAN addresses).
  allowedDevOrigins: ["10.10.0.12", "192.168.20.105"],
};

export default withWorkflow(nextConfig);
