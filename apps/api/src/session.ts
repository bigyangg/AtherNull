import { APIError } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";

import { auth } from "./auth.js";

export interface RequestSession {
  userId: string;
  organizationId: string | null;
}

export interface OrgSession {
  userId: string;
  organizationId: string;
  role: string;
}

// Better Auth's default organization roles (auth.ts doesn't override them) —
// "owner"/"admin" for actions more sensitive than plain org membership.
const PRIVILEGED_ORG_ROLES = new Set(["owner", "admin"]);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function requireSession(
  request: FastifyRequest,
): Promise<RequestSession> {
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });

  if (!result) {
    throw new HttpError(401, "Not signed in");
  }

  const activeOrganizationId =
    (result.session as { activeOrganizationId?: string | null })
      .activeOrganizationId ?? null;

  return { userId: result.user.id, organizationId: activeOrganizationId };
}

// Most routes below need a real org to scope tenant data to — a session
// with organizationId: null (legitimate today: org-creation UI doesn't
// exist yet, see apps/web's CurrentOrgProvider) can't create or read any of
// them, and must say so rather than silently scoping to nothing.
//
// A valid session alone isn't enough to prove current org access: Better
// Auth's session cookie can be cache-served for up to 5 minutes
// (auth.ts's session.cookieCache) without touching the database, and even
// without that cache, session.activeOrganizationId only reflects which org
// was active when the session was created/refreshed — not whether the user
// is still a member of it right now (removed-but-not-yet-signed-out is a
// real case, not hypothetical). auth.api.getActiveMember() re-queries the
// `member` table directly on every call, so a removed member is rejected
// immediately, not just once their session eventually expires.
export async function requireOrgSession(
  request: FastifyRequest,
): Promise<OrgSession> {
  const session = await requireSession(request);
  if (!session.organizationId) {
    throw new HttpError(
      403,
      "No active organization — create or select one first",
    );
  }

  const headers = fromNodeHeaders(request.headers);
  let member;
  try {
    member = await auth.api.getActiveMember({ headers });
  } catch (err) {
    if (err instanceof APIError) {
      throw new HttpError(403, "Not an active member of this organization");
    }
    throw err;
  }

  return {
    userId: session.userId,
    organizationId: session.organizationId,
    role: member.role,
  };
}

// Non-throwing form of the same owner/admin check below — for call sites
// that need a boolean to branch on (e.g. deciding whether a realtime
// connection holds realtime:control) rather than a request that should fail
// outright. Both this and requirePrivilegedRole share the exact same
// PRIVILEGED_ORG_ROLES set so the two can never silently drift apart.
export function hasPrivilegedRole(role: string): boolean {
  return PRIVILEGED_ORG_ROLES.has(role);
}

// For actions more sensitive than plain org membership (funding a task
// moves real money) — call after requireOrgSession, not instead of it.
export function requirePrivilegedRole(role: string): void {
  if (!hasPrivilegedRole(role)) {
    throw new HttpError(403, "This action requires an owner or admin role");
  }
}

// ADR-0007 Phase 3D — realtime:control authorization policy, decided
// explicitly (per the ADR's own requirement not to invent a vague new
// permission): a full source audit of this codebase's authorization surface
// found exactly one existing tier stricter than plain org membership —
// PRIVILEGED_ROLES/hasPrivilegedRole/requirePrivilegedRole above, already
// gating every real-money/business-lifecycle action (fund/verify/accept/
// reject in routes/jobs.ts). realtime:control — sending a command into a
// running execution, which can itself trigger real additional inference
// cost and mutate a live agent session — is deliberately gated on the exact
// same primitive, not a new, parallel permission concept: it is genuinely
// analogous in risk profile (real-world consequence beyond read access),
// and reusing the established tier keeps AtherNull's authorization surface
// to one stricter-than-member concept rather than two. This is a considered
// decision, not the default: realtime:view (Phase 3C) deliberately stayed
// at plain-member level because reading execution output is not analogous
// to those actions; realtime:control is.
export function hasRealtimeControlAuthority(role: string): boolean {
  return hasPrivilegedRole(role);
}

export function sendHttpError(reply: FastifyReply, err: unknown): boolean {
  if (err instanceof HttpError) {
    reply.status(err.status).send({ error: err.message });
    return true;
  }
  return false;
}
