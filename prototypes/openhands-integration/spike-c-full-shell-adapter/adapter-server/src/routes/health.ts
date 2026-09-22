// NOT one of the plan's originally-scoped 4 endpoints - discovered while
// running the real (non-mock) frontend against this adapter: before it will
// show the home page at all, OpenHands' backend-registry health probe
// (upstream/src/hooks/query/use-backends-health.ts's probeBackend() ->
// validateLocalBackend()) requires GET /api/settings and GET /server_info to
// both succeed for the active "local" backend - a "Manage backends" /
// "Disconnected" recovery modal is shown instead of the app otherwise. This
// is a genuine, measured cost this spike found beyond the mocks-derived
// contract in spike-a-standalone-shell/upstream/src/mocks/
// conversation-handlers.ts - logged in ../../service-contract.md and
// ../../metrics.json, not silently absorbed into "the 4 endpoints."
//
// Both responses below are honest, clearly-labeled stubs - never real
// AtherNull data (there is nothing in AtherNull to source them from) and
// never a value that could be mistaken for a real Agent Server's own state.
import type { Request, Response, Router } from "express";
import { Router as makeRouter } from "express";

export const healthRouter: Router = makeRouter();

// In-memory only, per adapter-process-lifetime, never forwarded to
// AtherNull. This is NOT a violation of the adapter's "read-only against
// AtherNull" rule - it is a local stand-in for the local agent-server's own
// misc_settings.app_preferences store (see below), entirely separate from
// AtherNull's real API surface, which this adapter still never sends
// anything but GET to.
const appPreferences: Record<string, unknown> = {
  language: "en",
  // Not null (OpenHands' own default, DEFAULT_SETTINGS in
  // src/services/settings.ts) - a null here makes
  // telemetry-consent-banner.tsx's shouldShow flip true and pop the "Help
  // improve OpenHands" consent modal on every load, which then covers the
  // sidebar/conversation list this spike's own smoke test needs to click
  // through. Pre-answering it "false" (consent declined) here is an honest,
  // documented adapter-local default - not a decision made on AtherNull's
  // or a real user's behalf against anything AtherNull controls.
  user_consents_to_analytics: false,
  enable_sound_notifications: false,
};

// GET /api/settings - discovered beyond the plan's originally-scoped 4
// endpoints (see this file's header comment). Two callers depend on this
// exact shape, not just a 200:
//  1. validateLocalBackend()'s health probe - only checks the call succeeds.
//  2. TelemetryConsentBanner (telemetry-consent-banner.tsx) - reads
//     `settings.user_consents_to_analytics`, which the real frontend derives
//     from `misc_settings.app_preferences.user_consents_to_analytics`
//     (settings-service.api.ts's transformApiResponse()/APP_PREFERENCE_FIELDS)
//     - NOT a flat top-level field the way the mock's unrelated cloud-proxy
//     `/api/v1/settings` stand-in shapes it. Getting this nesting wrong was
//     measured directly: an earlier flat-shaped stub left
//     user_consents_to_analytics falling through to DEFAULT_SETTINGS' `null`,
//     which permanently re-opened the consent modal over the sidebar after
//     every click (its Confirm button PATCHes this same endpoint, which
//     didn't exist yet either - see below).
healthRouter.get("/api/settings", (_req: Request, res: Response) => {
  res.json({
    agent_settings: {},
    conversation_settings: {},
    llm_api_key_is_set: false,
    misc_settings: { app_preferences: appPreferences },
  });
});

// PATCH /api/settings - accepts the real frontend's
// `{ misc_settings_diff: { app_preferences: {...} } }` shape (settings-
// service.api.ts's updateSettings()) and deep-merges it into the same
// in-memory store GET reads from, so the telemetry-consent banner's "Confirm
// preferences" button (and any other local-preference write, e.g. language)
// actually succeeds instead of 404ing - which, before this route existed,
// left the consent modal permanently stuck open (its onSubmit swallows the
// PATCH failure and never marks the choice submitted). Never forwarded
// anywhere - purely a local adapter-side stub, same as GET above.
healthRouter.patch("/api/settings", (req: Request, res: Response) => {
  const diff = (req.body as { misc_settings_diff?: { app_preferences?: Record<string, unknown> } } | undefined)
    ?.misc_settings_diff?.app_preferences;
  if (diff && typeof diff === "object") {
    Object.assign(appPreferences, diff);
  }
  res.json({
    agent_settings: {},
    conversation_settings: {},
    llm_api_key_is_set: false,
    misc_settings: { app_preferences: appPreferences },
  });
});

// GET /server_info - the other half of the health probe
// (agent-server-compatibility.ts's validateLocalBackend(): SettingsClient
// .getSettings() then ServerClient.getServerInfo(), which asserts `version`
// >= config/defaults.json's compatibility.minimumAgentServer, "1.28.0" at
// this pinned commit). `version` here is pinned to the exact
// @openhands/typescript-client version this frontend checkout's own
// package.json depends on (1.49.2) - an honest "this frontend's own
// expected floor," not a fabricated real Agent Server build.
healthRouter.get("/server_info", (_req: Request, res: Response) => {
  res.json({
    uptime: 0,
    idle_time: 0,
    title: "AtherNull Spike-C Adapter (stub - not a real Agent Server)",
    version: "1.49.2",
  });
});
