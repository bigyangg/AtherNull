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

// SECURITY FIX (post-Spike-D containment): the two real, verified callers of
// this adapter are Spike A's built frontend, served via
// `npx sirv build/ --single --port 4173` per this spike's own README's
// "How to reproduce" step 3, and Spike B/D's Next harness, served via
// `npm start -- --port 3902` per spike-b-selective-reuse/README.md's Spike D
// section. No credentials mode needed - the browser never holds or sends
// AtherNull's session cookie - but an explicit allowlist (not `origin: true`)
// is used regardless, since CORS is a browser-enforced same-origin control,
// not a network-access control: it does not stop a non-browser client from
// reaching this server directly (see the binding fix below for the actual
// network containment).
app.use(
  cors({
    origin: ["http://localhost:4173", "http://localhost:3902"],
  }),
);
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

// SECURITY FIX (post-Spike-D containment): explicit loopback-only bind.
// Spike D's verification found this previously bound to 0.0.0.0/[::] (all
// interfaces) because no host argument was passed here - confirmed via
// `netstat` and a successful `curl` to the machine's LAN IP. Binding to
// 127.0.0.1 is what actually contains network reachability to this machine;
// the CORS allowlist above only affects browser-enforced same-origin
// behavior and is not itself a network-access control.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[adapter-server] listening on http://127.0.0.1:${PORT}`);
  console.log(`[adapter-server] proxying AtherNull API at ${process.env.ATHERNULL_API_BASE ?? "http://localhost:3001"} (read-only)`);
});
