#!/usr/bin/env node
// Builds the patched Agent Canvas for AtherNull: served under /canvas, its
// only backend is AtherNull's agent gateway at <origin>/oh (same origin, so
// the AtherNull session cookie authenticates it), and "start a
// conversation" hands off to the AtherNull Builds extension.
//
//   CANVAS_PUBLIC_ORIGIN=https://app.example.com node apps/canvas/build.mjs
//   (default http://localhost:8080) -> apps/canvas/upstream/build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const upstream = join(here, "upstream");
const origin = (process.env.CANVAS_PUBLIC_ORIGIN ?? "http://localhost:8080").replace(/\/+$/, "");

execFileSync(process.execPath, [join(here, "brand.mjs")], { stdio: "inherit" });

execFileSync("npm", ["run", "build"], {
  cwd: upstream,
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    VITE_BASE_PATH: "/canvas",
    VITE_BACKEND_BASE_URL: `${origin}/oh`,
    // Placeholder only: the gateway drops it and authenticates the session.
    VITE_SESSION_API_KEY: "athernull-gateway",
    // No AtherNull session -> AtherNull sign-in, then back to the canvas.
    VITE_ATHERNULL_SESSION_URL: "/api/auth/get-session",
    // Org + agent workspace bootstrap (ADR-0018): no "missing sandbox" dead end.
    VITE_ATHERNULL_SANDBOX_URL: "/v1/agent-sandbox",
    VITE_MOCK_API: "false",
    // AtherNull mode: pinned version (no npm update nag), no community Slack.
    VITE_ATHERNULL: "1",
  },
});
console.log(`built ${join(upstream, "build")} for ${origin}`);
