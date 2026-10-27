import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Native addons and harness bridge assets must load through plain Node
  // resolution. Turbopack cannot bundle native binaries or the adapters'
  // package-relative bridge lockfiles (0006, 0085).
  serverExternalPackages: [
    "better-sqlite3",
    "ssh2",
    "@ai-sdk/harness",
    "@ai-sdk/harness-pi",
    "@ai-sdk/harness-claude-code",
    "@ai-sdk/harness-codex",
    "@ai-sdk/harness-cursor",
    "@ai-sdk/harness-acp",
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
