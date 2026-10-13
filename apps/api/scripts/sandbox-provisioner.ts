// ADR-0018 — the sandbox provisioner: creates organizations' agent
// workspaces on demand. A separate, privileged process (it needs Docker);
// apps/api only records requests. Started by `pnpm dev`; in production run it
// on the sandbox host. Design: docs/architecture/WORKSPACE_ONBOARDING.md.
//
//   pnpm --filter @athernull/api sandbox:provisioner
//
// - SANDBOX_PROVISIONER_CONCURRENCY loops (default 2) take requests side by
//   side; SKIP LOCKED gives each request to exactly one loop.
// - A warm pool of SANDBOX_WARM_POOL_SIZE (default 1, 0 disables) generic,
//   pre-booted sandboxes is kept, so a new organization's workspace is ready
//   in seconds. Requests always come first: the pool only refills while no
//   request is waiting or being set up.
// - Never more than SANDBOX_MAX_RUNNING sandboxes (organizations' + pool's):
//   a new organization past that waits in the queue.

import { sql } from "kysely";

import { db } from "../src/db.js";
import { provisionOrgSandbox, reconcilePool, runningSandboxCount, warmPoolSandbox, type ProvisionPhase } from "../src/sandbox/provision.js";
import { MAX_RUNNING } from "../src/sandbox/limits.js";

const POLL_MS = Number(process.env.SANDBOX_PROVISIONER_POLL_MS ?? 1000);
const CONCURRENCY = Math.max(1, Number(process.env.SANDBOX_PROVISIONER_CONCURRENCY ?? 2));
const POOL_SIZE = Math.max(0, Number(process.env.SANDBOX_WARM_POOL_SIZE ?? 1));
const POOL_CHECK_MS = 5000;
const log = (message: string) => console.log(`[provisioner] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Claims one PENDING request, or one stuck in PROVISIONING for 10+ minutes.
// A request for an organization without a sandbox waits while the host is
// at capacity and no pool sandbox is ready to hand over.
async function claim(): Promise<string | null> {
  const full = (await runningSandboxCount()) >= MAX_RUNNING;
  const rows = await sql<{ organization_id: string }>`
    update agent_sandbox_requests
       set status = 'PROVISIONING', claimed_at = now(), started_at = coalesce(started_at, now()),
           attempts = attempts + 1, updated_at = now()
     where organization_id = (
       select r.organization_id from agent_sandbox_requests r
        where (r.status = 'PENDING' or (r.status = 'PROVISIONING' and r.claimed_at < now() - interval '10 minutes'))
          and (${!full}
               or exists (select 1 from org_agent_servers s where s.organization_id = r.organization_id)
               or exists (select 1 from sandbox_pool p where p.status = 'READY'))
        order by r.requested_at
        limit 1
        for update skip locked
     )
    returning organization_id`.execute(db);
  return rows.rows[0]?.organization_id ?? null;
}

const setPhase = (organizationId: string) => async (phase: ProvisionPhase) => {
  await db.updateTable("agent_sandbox_requests").set({ phase, updated_at: new Date() }).where("organization_id", "=", organizationId).execute();
};

async function requestLoop(worker: number) {
  for (;;) {
    let organizationId: string | null = null;
    try {
      organizationId = await claim();
    } catch (err) {
      log(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!organizationId) {
      await sleep(POLL_MS);
      continue;
    }
    const started = Date.now();
    log(`[${worker}] provisioning workspace for organization ${organizationId}`);
    try {
      const result = await provisionOrgSandbox(organizationId, log, setPhase(organizationId));
      await db
        .updateTable("agent_sandbox_requests")
        .set({ status: "READY", phase: "READY", error: null, updated_at: new Date() })
        .where("organization_id", "=", organizationId)
        .execute();
      const how = result.pooled ? "from the warm pool" : result.reused ? "reused" : "new";
      log(`[${worker}] workspace ready for ${organizationId} (${how}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await db
        .updateTable("agent_sandbox_requests")
        .set({ status: "FAILED", phase: null, error: message, updated_at: new Date() })
        .where("organization_id", "=", organizationId)
        .execute();
      log(`[${worker}] provisioning failed for ${organizationId}: ${message}`);
    }
  }
}

// Requests waiting or being set up. The pool refills only when there are
// none: a booting pool sandbox would compete for the host's CPU and memory
// with a customer's workspace that is starting right now.
async function waitingRequests(): Promise<number> {
  const { n } = await db
    .selectFrom("agent_sandbox_requests")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("status", "in", ["PENDING", "PROVISIONING"])
    .executeTakeFirstOrThrow();
  return Number(n);
}

async function poolLoop() {
  for (;;) {
    try {
      await reconcilePool(log);
      if (POOL_SIZE > 0 && (await waitingRequests()) === 0) {
        const { n } = await db.selectFrom("sandbox_pool").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
        if (Number(n) < POOL_SIZE && (await runningSandboxCount()) < MAX_RUNNING) {
          log("warming a pool sandbox");
          await warmPoolSandbox(log);
          continue;
        }
      }
    } catch (err) {
      log(`warm pool: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(POOL_CHECK_MS);
  }
}

log(`online: ${CONCURRENCY} provisioning loop(s), warm pool of ${POOL_SIZE}, at most ${MAX_RUNNING} sandboxes`);
for (let i = 1; i <= CONCURRENCY; i++) void requestLoop(i);
void poolLoop();
