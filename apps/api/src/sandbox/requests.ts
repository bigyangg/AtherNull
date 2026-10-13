// ADR-0018 — requests for an organization's agent workspace, and what the
// canvas setup screen shows while one is being made
// (docs/architecture/WORKSPACE_ONBOARDING.md). apps/api only records
// requests; the provisioner (a separate process with Docker) acts on them.

import { db } from "../db.js";
import { HttpError } from "../session.js";
import { MAX_REQUESTS_PER_USER, MAX_RUNNING } from "./limits.js";

export type SandboxState = "READY" | "PENDING" | "PROVISIONING" | "FAILED" | "NONE";

export interface SandboxView {
  status: SandboxState;
  error: string | null;
  /** How far the provisioner has got (QUEUED, STARTING, BOOTING, CONFIGURING, READY). */
  phase: string | null;
  /** Workspaces requested before this one that are still waiting. */
  queuePosition: number;
  /** A pre-booted workspace is ready to hand out: setup takes seconds. */
  quickStart: boolean;
  /** No room for another workspace right now: it waits until there is. */
  atCapacity: boolean;
  requestedAt: string | null;
}

export async function sandboxState(organizationId: string): Promise<SandboxView> {
  const base = { phase: null, queuePosition: 0, quickStart: false, atCapacity: false, requestedAt: null };
  const server = await db.selectFrom("org_agent_servers").select("organization_id").where("organization_id", "=", organizationId).executeTakeFirst();
  if (server) return { ...base, status: "READY", error: null, phase: "READY" };
  const request = await db
    .selectFrom("agent_sandbox_requests")
    .select(["status", "error", "phase", "requested_at"])
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (!request) return { ...base, status: "NONE", error: null };

  const status = request.status as SandboxState;
  let queuePosition = 0;
  if (status === "PENDING") {
    const { ahead } = await db
      .selectFrom("agent_sandbox_requests")
      .select((eb) => eb.fn.countAll<string>().as("ahead"))
      .where("status", "=", "PENDING")
      .where("requested_at", "<", request.requested_at)
      .executeTakeFirstOrThrow();
    queuePosition = Number(ahead);
  }
  const { ready } = await db
    .selectFrom("sandbox_pool")
    .select((eb) => eb.fn.countAll<string>().as("ready"))
    .where("status", "=", "READY")
    .executeTakeFirstOrThrow();
  const { orgs } = await db.selectFrom("org_agent_servers").select((eb) => eb.fn.countAll<string>().as("orgs")).executeTakeFirstOrThrow();
  return {
    status,
    // Provisioner errors are operator detail (paths, Docker output): the
    // customer gets a plain message and a retry.
    error: status === "FAILED" ? "Your workspace could not be started." : null,
    phase: request.phase ?? (status === "PENDING" ? "QUEUED" : null),
    queuePosition,
    quickStart: Number(ready) > queuePosition,
    atCapacity: Number(ready) === 0 && Number(orgs) >= MAX_RUNNING,
    requestedAt: request.requested_at.toISOString(),
  };
}

/**
 * Records a request for the organization's workspace (idempotent; a FAILED
 * one is retried when `retryFailed`). A user may hold at most
 * MAX_REQUESTS_PER_USER requests across organizations, so creating many
 * organizations cannot start many sandboxes. Throws 429 past that.
 */
export async function requestSandbox(organizationId: string, userId: string, opts: { retryFailed: boolean }) {
  const server = await db.selectFrom("org_agent_servers").select("organization_id").where("organization_id", "=", organizationId).executeTakeFirst();
  if (server) return;
  const existing = await db
    .selectFrom("agent_sandbox_requests")
    .select("status")
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (!existing) {
    const { mine } = await db
      .selectFrom("agent_sandbox_requests")
      .select((eb) => eb.fn.countAll<string>().as("mine"))
      .where("requested_by", "=", userId)
      .executeTakeFirstOrThrow();
    if (Number(mine) >= MAX_REQUESTS_PER_USER) {
      throw new HttpError(429, `You already have ${MAX_REQUESTS_PER_USER} workspaces. Contact support@athernull.io for more.`);
    }
  }
  await db
    .insertInto("agent_sandbox_requests")
    .values({ organization_id: organizationId, requested_by: userId, phase: "QUEUED" })
    .onConflict((oc) =>
      opts.retryFailed
        ? oc
            .column("organization_id")
            .doUpdateSet({ status: "PENDING", phase: "QUEUED", error: null, started_at: null, requested_at: new Date(), updated_at: new Date() })
            .where("agent_sandbox_requests.status", "=", "FAILED")
        : oc.column("organization_id").doNothing(),
    )
    .execute();
}
