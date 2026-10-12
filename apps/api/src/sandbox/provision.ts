// ADR-0015/0018 — provision (or refresh) an organization's sandboxed OpenHands
// Agent Server: the backend the Agent Canvas reaches through apps/api's
// agent gateway, and where funded builds run as conversations.
//
//   pnpm --filter @athernull/api sandbox:provision -- --org <organizationId>
//
// Idempotent: reuses a registered, running sandbox whose run policy is
// unchanged and only re-applies its configuration; a sandbox started under
// an older policy is recreated on the same volume. The session key is
// generated here, stored for the gateway/worker, and never printed.
//
// How the container runs (image pin, network, limits) is sandbox/policy.ts.
// With SANDBOX_NETWORK set (production) the sandbox publishes no port: the
// gateway and worker reach it by container name on that network, and this
// provisioner (a host process) by its container IP.
//
// Env: DATABASE_URL, NVIDIA_NIM_API_KEY (sandbox LLM for the canvas),
//      SANDBOX_* (sandbox/policy.ts),
//      SANDBOX_LLM_MODEL (default nvidia_nim/nvidia/nemotron-3-super-120b-a12b)

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "kysely";

import { db } from "../db.js";
import {
  FIREWALL_MARKER_DIR,
  loadSandboxPolicy,
  policyFingerprint,
  registeredBaseUrl,
  sandboxRunArgs,
  type SandboxPolicy,
} from "./policy.js";

const LLM_MODEL = process.env.SANDBOX_LLM_MODEL ?? "nvidia_nim/nvidia/nemotron-3-super-120b-a12b";
const EXTENSION_DIR = fileURLToPath(new URL("../../../canvas/extension/athernull/", import.meta.url));
const EXTENSION_REMOTE_DIR = "/workspace/.athernull/extensions/athernull";

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function inspect(container: string, format: string): string {
  try {
    return docker("inspect", "--format", format, container);
  } catch {
    return "";
  }
}

/** Fails closed when the host firewall for the sandbox network is not in place. */
function assertFirewall(policy: SandboxPolicy) {
  if (!policy.enforceFirewall || !policy.network) return;
  const marker = join(FIREWALL_MARKER_DIR, `${policy.network}.firewall`);
  if (!existsSync(marker)) {
    throw new Error(
      `sandbox network policy is enforced but ${marker} is missing: run infrastructure/sandbox-network/athernull-sandbox-net.sh apply (docs/runbooks/sandbox-network.md)`,
    );
  }
}

/** Where this process reaches the sandbox while configuring it. */
function setupUrl(policy: SandboxPolicy, container: string, registered: string): string {
  if (!policy.network) return registered;
  const ip = inspect(container, `{{(index .NetworkSettings.Networks "${policy.network}").IPAddress}}`);
  if (!ip) throw new Error(`${container} has no address on ${policy.network}`);
  return `http://${ip}:8000`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitReady(baseUrl: string, key: string) {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${baseUrl}/server_info`, { headers: { "X-Session-API-Key": key } });
      if (res.ok) return (await res.json()) as { version?: string };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("agent server did not become ready");
}

async function call(baseUrl: string, key: string, method: string, path: string, body?: unknown | FormData, query?: Record<string, string>) {
  const url = new URL(path, `${baseUrl}/`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const isForm = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: { "X-Session-API-Key": key, ...(body && !isForm ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export interface ProvisionResult {
  baseUrl: string;
  version: string | null;
  reused: boolean;
}

export async function provisionOrgSandbox(
  organizationId: string,
  log: (message: string) => void = console.log,
): Promise<ProvisionResult> {
  // Better Auth's tables are not in the Kysely schema types.
  const org = (await sql<{ id: string; name: string }>`select id, name from "organization" where id = ${organizationId}`.execute(db)).rows[0];
  if (!org) throw new Error(`organization ${organizationId} not found`);
  let reused = false;
  const policy = loadSandboxPolicy();
  assertFirewall(policy);

  const container = `athernull-sandbox-${organizationId.slice(0, 8)}`;
  const existing = await db.selectFrom("org_agent_servers").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();
  const running = docker("ps", "-q", "--filter", `name=^${container}$`) !== "";
  const samePolicy = inspect(container, '{{index .Config.Labels "athernull.sandbox-policy"}}') === policyFingerprint(policy);

  let baseUrl: string;
  let key: string;
  if (existing && running && samePolicy && existing.container_name === container) {
    baseUrl = existing.base_url;
    key = existing.session_api_key;
    reused = true;
    log(`reusing ${container}`);
  } else {
    if (running && !samePolicy) log(`recreating ${container} under the current sandbox policy (volume kept)`);
    try {
      docker("rm", "-f", container);
    } catch {
      // nothing to remove
    }
    const port = policy.network ? null : await freePort();
    key = randomBytes(32).toString("hex");
    baseUrl = registeredBaseUrl(policy, container, port);
    docker(...sandboxRunArgs(policy, { container, key, hostPort: port }));
    log(`started ${container} (${policy.network ? `network ${policy.network}` : `127.0.0.1:${port}`})`);
  }

  // The registered URL is for the gateway/worker; this process may reach
  // the sandbox differently (by container IP from the host).
  const registered = baseUrl;
  baseUrl = setupUrl(policy, container, registered);
  const info = await waitReady(baseUrl, key);

  // The canvas's own LLM (titles, readiness). Agent work itself is still
  // only reachable through a funded build — see agent-gateway/policy.ts.
  if (process.env.NVIDIA_NIM_API_KEY) {
    await call(baseUrl, key, "PATCH", "/api/settings", {
      agent_settings_diff: { llm: { model: LLM_MODEL, api_key: process.env.NVIDIA_NIM_API_KEY } },
    });
    // The canvas only trusts an active LLM profile ("LLM isn't set up"), and
    // saving settings creates none: save the same LLM as "default", activate it.
    await call(baseUrl, key, "POST", "/api/profiles/default", {
      llm: { model: LLM_MODEL, api_key: process.env.NVIDIA_NIM_API_KEY },
    });
    await call(baseUrl, key, "POST", "/api/profiles/default/activate");
    log(`configured sandbox LLM ${LLM_MODEL}`);
  } else {
    log("NVIDIA_NIM_API_KEY not set: sandbox LLM left unconfigured");
  }

  // No product telemetry from AtherNull sandboxes (the canvas only sends
  // with consent; answering here also suppresses its consent dialog).
  await call(baseUrl, key, "PATCH", "/api/settings", { misc_settings_diff: { app_preferences: { user_consents_to_analytics: false } } });

  // AtherNull Builds canvas extension: upload, install, enable.
  for (const file of readdirSync(EXTENSION_DIR)) {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(join(EXTENSION_DIR, file))]), file);
    await call(baseUrl, key, "POST", "/api/file/upload", form, { path: `${EXTENSION_REMOTE_DIR}/${file}` });
  }
  await call(baseUrl, key, "POST", "/api/canvas-extensions/install", { source: EXTENSION_REMOTE_DIR, force: true });
  await call(baseUrl, key, "PATCH", "/api/canvas-extensions/installed/athernull", { enabled: true });
  log("installed and enabled the AtherNull Builds extension");

  // Registered last: the gateway (and the canvas's setup screen) treat a
  // registered sandbox as ready, so it must already be fully configured.
  await db
    .insertInto("org_agent_servers")
    .values({ organization_id: organizationId, base_url: registered, session_api_key: key, container_name: container })
    .onConflict((oc) =>
      oc.column("organization_id").doUpdateSet({ base_url: registered, session_api_key: key, container_name: container, updated_at: new Date() }),
    )
    .execute();
  log(`registered sandbox for "${org.name}" (agent-server ${info.version ?? "?"})`);

  return { baseUrl: registered, version: info.version ?? null, reused };
}
