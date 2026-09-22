// Spike C adapter server entry point. Implements exactly the 4 REST
// endpoints OpenHands' own MSW mocks stand in for
// (spike-a-standalone-shell/upstream/src/mocks/conversation-handlers.ts),
// each backed by a real read-only GET call to apps/api
// (athernull-client.ts). Nothing here ever touches the Agent Server
// SESSION_API_KEY concept, never proxies a live sandbox, and never forwards
// AtherNull's session cookie to a caller - see athernull-client.ts's header
// comment for the full trust-boundary explanation.
import cors from "cors";
import express from "express";

import { conversationsRouter } from "./routes/conversations.js";
import { eventsRouter } from "./routes/events.js";
import { healthRouter } from "./routes/health.js";

const PORT = Number(process.env.PORT ?? 4100);

const app = express();

// The OpenHands frontend (spike-a-standalone-shell/upstream, served on its
// own dev-server origin) calls this adapter cross-origin. No credentials
// mode needed - the browser never holds or sends AtherNull's session
// cookie, so a permissive CORS origin here does not widen the adapter's own
// trust boundary (it only decides which origins may read the *mapped*
// AtherNull-derived JSON these routes return).
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", role: "spike-c-adapter-server" });
});

// Mounted in this order (events before the bare conversations router)
// purely for readability - Express already disambiguates
// "/:id/events/..." from "/:id" correctly regardless of order, since "/:id"
// only matches when there is no further path segment.
app.use("/api/conversations", eventsRouter);
app.use("/api/conversations", conversationsRouter);
// Root-mounted: GET /api/settings and GET /server_info (backend-registry
// health probe - see health.ts's header comment).
app.use(healthRouter);

app.listen(PORT, () => {
  console.log(`[adapter-server] listening on http://localhost:${PORT}`);
  console.log(`[adapter-server] proxying AtherNull API at ${process.env.ATHERNULL_API_BASE ?? "http://localhost:3001"} (read-only)`);
});
