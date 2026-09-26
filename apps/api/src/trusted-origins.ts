// Shared "expected Origin(s)" computation — used both by @fastify/cors
// (app.ts, governs ordinary `fetch` requests) and by the ADR-0007 Phase 3C
// browser realtime gateway (routes/realtime-gateway.ts), which must
// explicitly validate `Origin` on the WebSocket upgrade itself, since
// ordinary CORS configuration does not govern WS upgrades at all (confirmed
// by reading @fastify/cors and the WebSocket upgrade handshake — a CORS
// plugin only ever runs its checks against `fetch`/XHR-initiated requests).
//
// Single source of truth, deliberately: before this file existed, an
// upgrade's Origin could only be checked against a second, independently
// computed list, which risks drifting from the CORS allowlist over time
// (e.g. someone adds a new trusted host to CORS and forgets the WS gate, or
// vice versa). Both call sites now read the exact same list.
//
// Dev/test setup, confirmed against this repo's own README/.env.example and
// the existing test suites' own hardcoded values (openhands-compat.test.ts /
// relay.test.ts both use AUTH_ORIGIN = "http://localhost:3000"): apps/web
// runs on localhost:3000, apps/api on localhost:3001, in local dev.
// TRUSTED_ORIGINS (comma-separated) overrides/extends this; WEB_APP_URL
// alone is treated as the single trusted origin if TRUSTED_ORIGINS isn't
// set — identical fallback behavior app.ts's CORS setup already had, now
// exported so the WS gate can reuse it verbatim instead of re-deriving it.
export function getTrustedOrigins(): string[] {
  return (process.env.TRUSTED_ORIGINS ?? process.env.WEB_APP_URL ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return getTrustedOrigins().includes(origin);
}
