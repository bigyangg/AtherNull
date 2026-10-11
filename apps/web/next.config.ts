import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The floating dev badge sits on top of the sidebar's account row.
  devIndicators: false,
  // @athernull/contracts is a SOURCE workspace package (main/types -> src/
  // index.ts, no dist). Listing it is an explicit opt-in to compiling its
  // TypeScript. This does NOT make Next resolve a relative `./x.js` import to
  // `x.ts` — neither Turbopack nor webpack does that — so the package's
  // internal relative imports must stay extensionless
  // (enforced by packages/contracts/src/packaging.test.ts).
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
