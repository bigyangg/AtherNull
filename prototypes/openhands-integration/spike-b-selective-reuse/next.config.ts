import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    resolveAlias: {
      // MANIFEST.md "react-i18next" row: scope-reduction shim, not a Next
      // incompatibility fix. Redirects the bare `react-i18next` package
      // specifier (used unmodified by every vendored file) to a local
      // passthrough `{ t: (k) => k }` implementation. Relative path (not
      // `path.join(__dirname, ...)`) — Turbopack's resolveAlias on Windows
      // does not accept an absolute backslash path here.
      "react-i18next": "./vendor/openhands/_shims/react-i18next.tsx",
    },
  },
};

export default nextConfig;
