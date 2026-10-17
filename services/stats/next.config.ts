import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The service is not part of the FORGE pnpm workspace; without this, Next picks the repo root
// (its lockfile) as root and nests the standalone output under services/stats.
const root = fileURLToPath(new URL(".", import.meta.url));

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  // Traefik in front compresses.
  compress: false,
  poweredByHeader: false,
};

export default nextConfig;
