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
import { projectFundingRoutes } from "./routes/project-funding.js";
import { projectRoutes } from "./routes/projects.js";
import { agentGatewayRoutes } from "./routes/agent-gateway.js";
import { agentSandboxRoutes } from "./routes/agent-sandbox.js";
import { buildRoutes } from "./routes/builds.js";
import { chatBuildRoutes } from "./routes/chat-builds.js";
import { discussionRoutes } from "./routes/discussions.js";
import { changeRequestRoutes } from "./routes/change-requests.js";
import { previewRoutes } from "./routes/previews.js";
import { repoTransferRoutes } from "./routes/repo-transfer.js";
import { verificationRoutes } from "./routes/verification.js";
import { realtimeGatewayRoutes } from "./routes/realtime-gateway.js";
import { MAX_RELAY_MESSAGE_BYTES, relayRoutes } from "./routes/relay.js";
import { taskProvenanceRoutes } from "./routes/task-provenance.js";
import { getTrustedOrigins } from "./trusted-origins.js";
import { usageRoutes } from "./routes/usage.js";
import { usagePolicyRoutes } from "./routes/usage-policies.js";

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
  // Phase 4C — the canonical, provenance-bound way to create a task. Also
  // deliberately its own route file: see routes/task-provenance.ts's header
  // comment and apps/api/test/task-provenance-no-execution-path.test.ts.
  await app.register(taskProvenanceRoutes);
  // Phase 4E.1 — Solana devnet project funding. Its own route file; see
  // routes/project-funding.ts and project-funding-no-execution-path.test.ts.
  await app.register(projectFundingRoutes);
  await app.register(usageRoutes);
  // Phase 4D.2A — operational usage limits + pause/resume. A SOFT,
  // POST-RESPONSE token limit, never monetary — deliberately its own route
  // file: see routes/usage-policies.ts's header comment. Never writes
  // task.max_budget_minor/project_budget_authorizations/cost_minor/
  // payment_intents (correction 23).
  await app.register(usagePolicyRoutes);
  await app.register(internalRoutes);
  // ADR-0017 — patch capture + independent verifier endpoints.
  await app.register(verificationRoutes);
  await app.register(repoTransferRoutes);
  // Live previews of verified builds (sandboxed, see routes/previews.ts).
  await app.register(previewRoutes);
  // Request changes on a verified build (routes/change-requests.ts).
  await app.register(changeRequestRoutes);
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
  // ADR-0015 — agent gateway: the real OpenHands Agent Canvas's only
  // backend (/oh/*), proxying to the org's sandboxed Agent Server behind
  // AtherNull auth and the funded-build gate.
  await app.register(agentGatewayRoutes);
  await app.register(discussionRoutes);
  await app.register(chatBuildRoutes);
  await app.register(agentSandboxRoutes);
  await app.register(buildRoutes);
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
