// The organization's sandboxed Agent Server (ADR-0015): where it is and its
// session key. Server-side only — the key never reaches a browser.
import { db } from "../db.js";
import { HttpError } from "../session.js";

export interface OrgServer {
  baseUrl: string;
  key: string;
}

export async function loadOrgServer(organizationId: string): Promise<OrgServer> {
  const row = await db
    .selectFrom("org_agent_servers")
    .select(["base_url", "session_api_key"])
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (!row) throw new HttpError(503, "No agent sandbox is provisioned for this organization yet");
  return { baseUrl: row.base_url.replace(/\/+$/, ""), key: row.session_api_key };
}
