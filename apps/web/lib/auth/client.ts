"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient, organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  plugins: [magicLinkClient(), organizationClient()],
  fetchOptions: {
    // The API lives on a different origin (different port in dev, different
    // subdomain in prod) — without this the session cookie Better Auth sets
    // is never sent back on subsequent requests.
    credentials: "include",
  },
});

export const { signIn, signUp, signOut, useSession, requestPasswordReset, resetPassword } =
  authClient;

/**
 * Call this after any authClient.organization.{create,setActive,delete,
 * removeMember,leave,acceptInvitation} call succeeds.
 *
 * Confirmed by direct inspection of Better Auth 1.7.5's organization plugin
 * (apps/api/src/auth.ts's session.cookieCache is enabled, 5 min maxAge): all
 * of those endpoints update `session.activeOrganizationId` in the database
 * but do not reissue the session cache cookie afterward. The client SDK's
 * own auto-refetch (every one of those calls fires the `$sessionSignal`
 * atom, which re-triggers `useSession`) reuses the same cached
 * `/get-session` fetch, so without this it would silently read the
 * *pre-mutation* cached session — e.g. a customer creating their first
 * organization would see "No active organization" errors for up to 5
 * minutes right after creating it. `disableCookieCache: true` forces a real
 * database read and — confirmed, not assumed — makes the server reissue a
 * correctly updated cache cookie, so this also fixes every subsequent
 * request, not just the immediate one.
 */
export async function refreshSessionAfterOrgChange(): Promise<void> {
  await authClient.getSession({ query: { disableCookieCache: true } });
}

/**
 * Turns a same-app path into an absolute URL on THIS origin. Required for
 * every callbackURL/errorCallbackURL passed to the auth client: Better Auth
 * resolves a relative callbackURL against the API's own origin (it's the
 * server building the redirect), not the web app's — so a bare "/projects"
 * would send a clicked email link to the API's origin instead of here.
 */
export function absoluteUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}
