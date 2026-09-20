import { betterAuth } from "better-auth";
import { haveIBeenPwned, magicLink, organization } from "better-auth/plugins";
import { Pool } from "pg";

import { db } from "./db.js";
import {
  sendMagicLinkEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "./email.js";

// Seeded for every auto-created personal org (see databaseHooks.user.create.after
// below) so a task can always be created without a profile-management UI.
// Cheapest -> most capable, matching agent_profiles.model_tiers' documented
// shape (packages/database/migrations/0002_platform_tables.sql) and ADR-0003.
const DEFAULT_MODEL_TIERS = [
  { tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 0.33, costCeilingMinor: 50 },
  { tier: "standard", model: "anthropic/claude-sonnet-5", maxComplexity: 0.75 },
  { tier: "advanced", model: "anthropic/claude-opus-5", maxComplexity: 1 },
];

// The web app's own origin — where the user actually resets their password,
// as opposed to `BETTER_AUTH_URL` (this API's origin, used for verification
// and magic-link links, which are real GET routes Better Auth serves itself).
const webAppUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? process.env.WEB_APP_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// ADR-0004 (docs/adr/0004-better-auth-for-identity.md): Better Auth owns the
// identity schema (organization/member/invitation/user/session), generated
// via its own CLI into packages/database/migrations/0001_better_auth_schema.sql
// — never hand-edited. Every other table's organization_id/owner references
// point at what this generates.
//
// Sign-in methods (2026-09-20): email/password + magic link, both delivered
// through Resend now that the athernull.io domain is verified for sending.
// Email verification is mandatory before a session is issued — see
// `emailAndPassword.requireEmailVerification` below.
export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins,

  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),

  advanced: {
    // Every hand-written table already uses `uuid primary key default
    // gen_random_uuid()` — match that instead of Better Auth's default
    // base62 string ids, so foreign keys stay a plain `uuid` column.
    database: {
      generateId: "uuid",
    },
    // Cookies are always Secure outside local dev, even if BETTER_AUTH_URL
    // is ever misconfigured as http:// behind a TLS-terminating proxy.
    useSecureCookies: process.env.NODE_ENV === "production",
    // Set only when the web and api apps share a parent domain in
    // production (e.g. app.athernull.io / api.athernull.io) so the session
    // cookie is sent on both. Left unset in local dev (different ports on
    // localhost are already same-site, so no special cookie domain needed).
    ...(process.env.COOKIE_DOMAIN
      ? { crossSubDomainCookies: { enabled: true, domain: process.env.COOKIE_DOMAIN } }
      : {}),
  },

  // Off by default outside production upstream — explicit here so local dev
  // and prod behave the same way and the limits below are actually exercised
  // before shipping. Global limit is deliberately loose; the per-path rules
  // below carry the real protection against credential stuffing / enumeration.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 30,
    customRules: {
      // Overridable only for tenant-authorization.test.ts, which legitimately
      // signs up and signs in more than 5 real users inside one 60s window
      // (Fastify's inject() has no resolvable client IP, so every request
      // shares one bucket — see the WARN this prints). Production keeps the
      // real limit.
      "/sign-in/email": { window: 60, max: Number(process.env.AUTH_TEST_RATE_LIMIT_MAX ?? 5) },
      "/sign-up/email": { window: 60, max: Number(process.env.AUTH_TEST_RATE_LIMIT_MAX ?? 5) },
      "/sign-in/magic-link": { window: 60, max: 5 },
      "/request-password-reset": { window: 60, max: 3 },
      "/reset-password": { window: 60, max: 5 },
      "/send-verification-email": { window: 60, max: 3 },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh at most once a day
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 min — cuts a DB round trip per request without staling auth state for long
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    resetPasswordTokenExpiresIn: 60 * 60, // 1 hour
    sendResetPassword: async ({ user, token }) => {
      const url = `${webAppUrl}/reset-password?token=${encodeURIComponent(token)}`;
      await sendPasswordResetEmail({ to: user.email, name: user.name, url });
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, name: user.name, url });
    },
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60, // 1 hour
  },

  // No org-creation UI exists yet (apps/web's CurrentOrgProvider), and every
  // /v1/* route 403s without an active org (session.ts's requireOrgSession)
  // — so every new user gets a personal organization automatically instead
  // of being blocked out of the product until one is built.
  databaseHooks: {
    user: {
      create: {
        // Called with no request/session context (server-side, not via the
        // HTTP endpoint) — passing `userId` in the body is exactly the
        // documented "server-only" path for /organization/create, and
        // deliberately does NOT set session.activeOrganizationId itself
        // (that endpoint only does that when ctx.context.session is
        // present, i.e. called through a real logged-in request). The
        // session.create hook below is what actually activates it, the
        // first time this user's session is created.
        after: async (user) => {
          const org = await auth.api.createOrganization({
            body: {
              name: `${user.name}'s Workspace`,
              slug: `org-${user.id}`,
              userId: user.id,
            },
          });
          if (!org) return;

          await db
            .insertInto("agent_profiles")
            .values({
              organization_id: org.id,
              model_tiers: JSON.stringify(DEFAULT_MODEL_TIERS),
              policy_version: "v1",
            })
            .execute();
        },
      },
    },
    session: {
      create: {
        // A session can be created with no active org set at all (fresh
        // sign-in) — if so, default it to the user's oldest membership
        // (their auto-created personal org, unless they've since joined or
        // been invited elsewhere). Never overrides an org the client
        // explicitly requested.
        before: async (session) => {
          if ((session as { activeOrganizationId?: string | null }).activeOrganizationId) {
            return;
          }

          const membership = await db
            .selectFrom("member")
            .select("organizationId")
            .where("userId", "=", session.userId)
            .orderBy("createdAt", "asc")
            .limit(1)
            .executeTakeFirst();

          if (!membership) return;
          return { data: { activeOrganizationId: membership.organizationId } };
        },
      },
    },
  },

  plugins: [
    organization(),
    magicLink({
      expiresIn: 60 * 15, // 15 minutes
      sendMagicLink: async ({ email, url }) => {
        await sendMagicLinkEmail({ to: email, url });
      },
    }),
    // Rejects passwords found in the Have I Been Pwned breach corpus on
    // sign-up/reset. Only a k-anonymity SHA-1 prefix leaves the server, per
    // HIBP's API — no plaintext or full hash is ever sent.
    haveIBeenPwned(),
  ],
});
