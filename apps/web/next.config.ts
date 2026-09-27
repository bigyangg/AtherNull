import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @athernull/contracts ships untranspiled TypeScript (main: src/index.ts,
  // internal exports written with .js specifiers per its own moduleResolution
  // config) — without this, Next treats it as an opaque external package and
  // fails to resolve those .js specifiers against the actual .ts files.
  transpilePackages: ["@athernull/contracts"],
  // Self-contained server bundle (.next/standalone) for the Docker image —
  // pulls in only the node_modules this app's build actually traced, instead
  // of shipping the whole monorepo's node_modules.
  output: "standalone",
  // Turbopack auto-detects the workspace root by walking up for the nearest
  // lockfile, which breaks in the Docker build (only apps/web + the root
  // manifests are copied in, not every workspace member) — it lands on
  // apps/web itself and then can't see the hoisted next/package.json.
  // Pin it explicitly to the monorepo root instead of relying on detection.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
