import type { FastifyReply, FastifyRequest } from "fastify";

// Credential for /internal/* — a worker has no user/session, so this is
// deliberately separate from Better Auth. PLAN.md §1: the agent/worker
// never gets prod DB creds or escrow signing keys; this token only grants
// access to the claim/heartbeat/complete endpoints below, nothing else.
export function requireInternalToken(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  const header = request.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!expected || !provided || provided !== expected) {
    reply.status(401).send({ error: "Invalid or missing internal token" });
    return false;
  }
  return true;
}
