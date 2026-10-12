// The organization's sandboxed Agent Server (ADR-0015): where it is and its
// session key. Server-side only — the key never reaches a browser.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { db } from "../db.js";
import { HttpError } from "../session.js";

export interface OrgServer {
  baseUrl: string;
  key: string;
}

const run = promisify(execFile);
const addresses = new Map<string, { url: string; at: number }>();
const ADDRESS_TTL_MS = 15_000;

/**
 * Where this process can reach a sandbox. Sandboxes on the isolated network
 * are registered by container name, which only resolves inside that
 * network; an API or worker running on the host itself (SANDBOX_REACH=ip)
 * reaches them by their current container IP instead (the host firewall
 * allows host -> sandbox, docs/runbooks/sandbox-network.md).
 */
export async function reachableSandboxUrl(baseUrl: string): Promise<string> {
  const network = process.env.SANDBOX_NETWORK?.trim();
  if (process.env.SANDBOX_REACH !== "ip" || !network) return baseUrl;
  const match = /^http:\/\/(athernull-sandbox-[0-9a-f]{8}):(\d+)\/*$/.exec(baseUrl);
  if (!match) return baseUrl;
  const [, container, port] = match;
  const cached = addresses.get(container!);
  if (cached && Date.now() - cached.at < ADDRESS_TTL_MS) return cached.url;
  const { stdout } = await run("docker", ["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container!]).catch(() => ({ stdout: "" }));
  const ip = stdout.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new HttpError(503, "The agent sandbox is not running right now");
  const url = `http://${ip}:${port}`;
  addresses.set(container!, { url, at: Date.now() });
  return url;
}

export async function loadOrgServer(organizationId: string): Promise<OrgServer> {
  const row = await db
    .selectFrom("org_agent_servers")
    .select(["base_url", "session_api_key"])
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
  if (!row) throw new HttpError(503, "No agent sandbox is provisioned for this organization yet");
  return { baseUrl: await reachableSandboxUrl(row.base_url.replace(/\/+$/, "")), key: row.session_api_key };
}
