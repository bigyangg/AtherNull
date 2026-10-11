// ADR-0018 — the sandbox provisioner: creates organizations' agent
// workspaces on demand. A separate, privileged process (it needs Docker);
// apps/api only records requests. Started by `pnpm dev`; in production run it
// on the sandbox host.
//
//   pnpm --filter @athernull/api sandbox:provisioner

import { sql } from "kysely";

import { db } from "../src/db.js";
import { provisionOrgSandbox } from "../src/sandbox/provision.js";

const POLL_MS = Number(process.env.SANDBOX_PROVISIONER_POLL_MS ?? 2000);
const log = (message: string) => console.log(`[provisioner] ${message}`);

// Claims one PENDING request, or one stuck in PROVISIONING for 10+ minutes.
async function claim(): Promise<string | null> {
  const rows = await sql<{ organization_id: string }>`
    update agent_sandbox_requests
       set status = 'PROVISIONING', claimed_at = now(), attempts = attempts + 1, updated_at = now()
     where organization_id = (
       select organization_id from agent_sandbox_requests
        where status = 'PENDING'
           or (status = 'PROVISIONING' and claimed_at < now() - interval '10 minutes')
        order by requested_at
        limit 1
        for update skip locked
     )
    returning organization_id`.execute(db);
  return rows.rows[0]?.organization_id ?? null;
}

async function main() {
  log(`online, polling every ${POLL_MS}ms`);
  for (;;) {
    let organizationId: string | null = null;
    try {
      organizationId = await claim();
    } catch (err) {
      log(`claim failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!organizationId) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }
    log(`provisioning workspace for organization ${organizationId}`);
    try {
      const result = await provisionOrgSandbox(organizationId, log);
      await db
        .updateTable("agent_sandbox_requests")
        .set({ status: "READY", error: null, updated_at: new Date() })
        .where("organization_id", "=", organizationId)
        .execute();
      log(`workspace ready for ${organizationId} (${result.reused ? "reused" : "new"})`);
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await db
        .updateTable("agent_sandbox_requests")
        .set({ status: "FAILED", error: message, updated_at: new Date() })
        .where("organization_id", "=", organizationId)
        .execute();
      log(`provisioning failed for ${organizationId}: ${message}`);
    }
  }
}

void main();
