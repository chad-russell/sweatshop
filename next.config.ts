import type { NextConfig } from "next";
import { withEve } from "eve/next";

const nextConfig: NextConfig = {
  // Next dev 403-blocks /_next/* assets whose Origin/Referer host isn't
  // allowlisted — the app HTML loads but no JS hydrates, so forms fall
  // back to native GET submits. Allow the hosts we reach the dev server
  // from (localhost is allowed by default; these are bee's Nebula and
  // LAN addresses).
  allowedDevOrigins: ["10.10.0.12", "192.168.20.105"],
};

export default withEve(nextConfig);
