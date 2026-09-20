import cors from "@fastify/cors";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyInstance } from "fastify";

import { auth } from "./auth.js";
import { agentProfileRoutes } from "./routes/agent-profiles.js";
import { internalRoutes } from "./routes/internal.js";
import { jobRoutes } from "./routes/jobs.js";
import { projectRoutes } from "./routes/projects.js";

// Split from index.ts so tests can build the app in-process (Fastify's
// `inject()`) against a real test database, without binding a real port.
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? process.env.WEB_APP_URL ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  // The web app calls this API cross-origin (different port in dev, different
  // subdomain in prod) and needs the session cookie sent back, so this can't
  // be `origin: "*"` — a wildcard origin is incompatible with credentials
  // anyway, and would defeat the point of trustedOrigins on the auth side.
  await app.register(cors, {
    origin: trustedOrigins,
    credentials: true,
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Phase 1 — core job engine (PLAN.md §2). projectRoutes/jobRoutes are
  // session-scoped (Better Auth); internalRoutes are the worker-facing
  // claim/heartbeat/complete surface, gated by INTERNAL_API_TOKEN instead.
  await app.register(projectRoutes);
  await app.register(jobRoutes);
  await app.register(agentProfileRoutes);
  await app.register(internalRoutes);

  // Better Auth owns everything under /api/auth/* (ADR-0004). Fastify hands the
  // raw Node request/response straight to auth.handler via the Fetch API
  // adapter — per Better Auth's own Fastify integration guide, not a custom
  // scheme, so upgrades to the library don't require re-deriving this.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);

      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });

      const response = await auth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  return app;
}
