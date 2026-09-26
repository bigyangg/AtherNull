import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyInstance } from "fastify";

import { auth } from "./auth.js";
import { agentProfileRoutes } from "./routes/agent-profiles.js";
import { budgetAuthorizationRoutes } from "./routes/budget-authorizations.js";
import { estimateRoutes } from "./routes/estimates.js";
import { internalRoutes } from "./routes/internal.js";
import { jobRoutes } from "./routes/jobs.js";
import { openhandsCompatRoutes } from "./routes/openhands-compat.js";
import { projectRoutes } from "./routes/projects.js";
import { realtimeGatewayRoutes } from "./routes/realtime-gateway.js";
import { MAX_RELAY_MESSAGE_BYTES, relayRoutes } from "./routes/relay.js";
import { getTrustedOrigins } from "./trusted-origins.js";
import { usageRoutes } from "./routes/usage.js";

// Split from index.ts so tests can build the app in-process (Fastify's
// `inject()`) against a real test database, without binding a real port.
export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  const trustedOrigins = getTrustedOrigins();

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
  // Phase 4A — project scope/build-plan/cost-estimate lineage. Deliberately
  // its own route file, not merged into jobs.ts: estimates never touch
  // tasks/executions or reach dispatch (see routes/estimates.ts's header
  // comment and apps/api/test/estimates-no-execution-path.test.ts).
  await app.register(estimateRoutes);
  // Phase 4B — authorized project budget. Also deliberately its own route
  // file, not merged into estimates.ts or jobs.ts: authorizing a budget
  // never creates a task/execution/payment_intents row in this phase (see
  // routes/budget-authorizations.ts's header comment and
  // apps/api/test/budget-authorizations-no-execution-path.test.ts).
  await app.register(budgetAuthorizationRoutes);
  await app.register(usageRoutes);
  await app.register(internalRoutes);
  // ADR-0007 Phase 3B — worker -> apps/api outbound relay tunnel.
  // @fastify/websocket must be registered before relayRoutes (it decorates
  // the fastify instance with the `websocket: true` route option and the
  // request lifecycle hooks relayRoutes relies on). maxPayload bounds every
  // relay message's size at the transport level; routes/relay.ts applies
  // the same bound again at the application level for defense in depth.
  await app.register(websocket, { options: { maxPayload: MAX_RELAY_MESSAGE_BYTES } });
  await app.register(relayRoutes);
  // ADR-0007 Phase 3C — authenticated browser realtime viewing gateway.
  // Registered on the same already-installed @fastify/websocket plugin
  // instance as relayRoutes above (no second websocket plugin registration
  // needed — @fastify/websocket decorates the whole Fastify instance once).
  await app.register(realtimeGatewayRoutes);
  // Phase 2 — OpenHands compatibility layer (ADR-0006). Registers its own
  // literal `/api/conversations/*`, `/api/settings`, `/server_info` paths
  // directly; it doesn't collide with Better Auth's `/api/auth/*` catch-all
  // below.
  await app.register(openhandsCompatRoutes);

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
