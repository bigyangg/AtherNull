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
// A NEW organization is handed a pre-booted sandbox from the warm pool when
// one is ready (docs/architecture/WORKSPACE_ONBOARDING.md): seconds instead
// of the ~50s a cold agent server needs to unpack and boot.
//
// How the container runs (image pin, network, limits) is sandbox/policy.ts.
// With SANDBOX_NETWORK set (production) the sandbox publishes no port: the
// gateway and worker reach it by container name on that network, and this
// provisioner (a host process) by its container IP.
//
// Env: DATABASE_URL, NVIDIA_NIM_API_KEY (sandbox LLM for the canvas),
//      SANDBOX_* (sandbox/policy.ts),
//      SANDBOX_LLM_MODEL (default nvidia_nim/nvidia/nemotron-3-super-120b-a12b)

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

/** How far an organization's workspace has got (agent_sandbox_requests.phase). */
export type ProvisionPhase = "QUEUED" | "STARTING" | "BOOTING" | "CONFIGURING" | "READY";

const run = promisify(execFile);

// Async so several provisioner loops really run side by side. Arguments are
// always an array (never a shell string).
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function inspect(container: string, format: string): Promise<string> {
  try {
    return await docker("inspect", "--format", format, container);
  } catch {
    return "";
  }
}

async function removeContainer(container: string) {
  try {
    await docker("rm", "-f", container);
  } catch {
    // already gone
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
async function setupUrl(policy: SandboxPolicy, container: string, registered: string): Promise<string> {
  if (!policy.network) return registered;
  const ip = await inspect(container, `{{(index .NetworkSettings.Networks "${policy.network}").IPAddress}}`);
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

async function serverInfo(baseUrl: string, key: string, timeoutMs = 3000): Promise<{ version?: string } | null> {
  try {
    const res = await fetch(`${baseUrl}/server_info`, { headers: { "X-Session-API-Key": key }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as { version?: string }) : null;
  } catch {
    return null;
  }
}

async function waitReady(baseUrl: string, key: string) {
  // ~3 minutes: the agent server unpacks itself (~30s) before it boots.
  for (let i = 0; i < 180; i++) {
    const info = await serverInfo(baseUrl, key);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 1000));
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

/**
 * Identifies what configureSandbox applies (LLM model, the key — hashed —
 * and the extension files), so a pool sandbox configured with anything
 * older is discarded rather than handed out.
 */
export function configFingerprint(): string {
  const hash = createHash("sha256");
  hash.update(LLM_MODEL);
  hash.update(createHash("sha256").update(process.env.NVIDIA_NIM_API_KEY ?? "").digest("hex"));
  for (const file of readdirSync(EXTENSION_DIR).sort()) {
    hash.update(file);
    hash.update(readFileSync(join(EXTENSION_DIR, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

/** Everything a sandbox needs that is the same for every organization. */
async function configureSandbox(baseUrl: string, key: string, log: (message: string) => void) {
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
}

/** A container name no existing container uses. */
async function freshContainerName(): Promise<string> {
  for (;;) {
    const name = `athernull-sandbox-${randomBytes(4).toString("hex")}`;
    if (!(await inspect(name, "{{.Id}}"))) return name;
  }
}

/** Starts a sandbox container; resolves once its agent server answers. */
async function startSandbox(policy: SandboxPolicy, container: string, opts: { pool?: boolean } = {}) {
  const port = policy.network ? null : await freePort();
  const key = randomBytes(32).toString("hex");
  const registered = registeredBaseUrl(policy, container, port);
  await docker(...sandboxRunArgs(policy, { container, key, hostPort: port, pool: opts.pool }));
  return { key, registered };
}

export interface ProvisionResult {
  baseUrl: string;
  version: string | null;
  reused: boolean;
  /** Handed a pre-booted sandbox from the warm pool. */
  pooled: boolean;
}

async function register(organizationId: string, baseUrl: string, key: string, container: string, trx: typeof db = db) {
  await trx
    .insertInto("org_agent_servers")
    .values({ organization_id: organizationId, base_url: baseUrl, session_api_key: key, container_name: container })
    .onConflict((oc) =>
      oc.column("organization_id").doUpdateSet({ base_url: baseUrl, session_api_key: key, container_name: container, updated_at: new Date() }),
    )
    .execute();
}

/**
 * Hands the oldest ready pool sandbox to a new organization, atomically: in
 * one transaction it is locked, health-checked, removed from the pool and
 * registered to the organization, so it can never go to two organizations
 * and a crash leaves it in exactly one place. Only sandboxes matching the
 * current policy and configuration qualify. A pool sandbox that fails its
 * health check is dropped and the next one tried. Null when none is ready.
 */
export async function takePooledSandbox(
  organizationId: string,
  fingerprints: { policy: string; config: string },
  reach: (registered: string, container: string) => Promise<string>,
  log: (message: string) => void = console.log,
): Promise<{ container: string; baseUrl: string; version: string | null } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("sandbox_pool")
        .selectAll()
        .where("status", "=", "READY")
        .where("policy_fingerprint", "=", fingerprints.policy)
        .where("config_fingerprint", "=", fingerprints.config)
        .orderBy("ready_at", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return null;
      await trx.deleteFrom("sandbox_pool").where("container_name", "=", row.container_name).execute();
      const info = await serverInfo(await reach(row.base_url, row.container_name).catch(() => row.base_url), row.session_api_key);
      if (!info) return { dead: row.container_name } as const;
      await register(organizationId, row.base_url, row.session_api_key, row.container_name, trx);
      return { container: row.container_name, baseUrl: row.base_url, version: info.version ?? null } as const;
    });
    if (!outcome) return null;
    if ("dead" in outcome) {
      log(`dropped unhealthy pool sandbox ${outcome.dead}`);
      await removeContainer(outcome.dead!);
      continue;
    }
    return outcome;
  }
  return null;
}

export async function provisionOrgSandbox(
  organizationId: string,
  log: (message: string) => void = console.log,
  onPhase: (phase: ProvisionPhase) => Promise<void> | void = () => {},
): Promise<ProvisionResult> {
  // Better Auth's tables are not in the Kysely schema types.
  const org = (await sql<{ id: string; name: string }>`select id, name from "organization" where id = ${organizationId}`.execute(db)).rows[0];
  if (!org) throw new Error(`organization ${organizationId} not found`);
  const policy = loadSandboxPolicy();
  assertFirewall(policy);
  const reach = (registered: string, container: string) => setupUrl(policy, container, registered);

  const existing = await db.selectFrom("org_agent_servers").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();

  // A new organization: a pre-booted sandbox from the warm pool, if ready.
  // Existing organizations never get one — their data is on their own volume.
  if (!existing) {
    const pooled = await takePooledSandbox(organizationId, { policy: policyFingerprint(policy), config: configFingerprint() }, reach, log);
    if (pooled) {
      log(`handed pool sandbox ${pooled.container} to "${org.name}"`);
      return { baseUrl: pooled.baseUrl, version: pooled.version, reused: false, pooled: true };
    }
  }

  // An organization keeps its container (and so its volume) for life; a new
  // one without a pool sandbox gets a fresh, unused name.
  const container = existing?.container_name ?? (await freshContainerName());
  const running = (await docker("ps", "-q", "--filter", `name=^${container}$`)) !== "";
  const samePolicy = (await inspect(container, '{{index .Config.Labels "athernull.sandbox-policy"}}')) === policyFingerprint(policy);

  let registered: string;
  let key: string;
  let reused = false;
  if (existing && running && samePolicy) {
    registered = existing.base_url;
    key = existing.session_api_key;
    reused = true;
    log(`reusing ${container}`);
  } else {
    await onPhase("STARTING");
    if (running && !samePolicy) log(`recreating ${container} under the current sandbox policy (volume kept)`);
    await removeContainer(container);
    ({ key, registered } = await startSandbox(policy, container));
    log(`started ${container} (${policy.network ? `network ${policy.network}` : registered})`);
  }

  await onPhase("BOOTING");
  const baseUrl = await reach(registered, container);
  const info = await waitReady(baseUrl, key);
  await onPhase("CONFIGURING");
  await configureSandbox(baseUrl, key, log);

  // Registered last: the gateway (and the canvas's setup screen) treat a
  // registered sandbox as ready, so it must already be fully configured.
  await register(organizationId, registered, key, container);
  log(`registered sandbox for "${org.name}" (agent-server ${info.version ?? "?"})`);
  return { baseUrl: registered, version: info.version ?? null, reused, pooled: false };
}

// --- Warm pool ---------------------------------------------------------------

/** Boots and configures one generic pool sandbox, then marks it READY. */
export async function warmPoolSandbox(log: (message: string) => void = console.log): Promise<string> {
  const policy = loadSandboxPolicy();
  assertFirewall(policy);
  const container = await freshContainerName();
  const port = policy.network ? null : await freePort();
  const key = randomBytes(32).toString("hex");
  const registered = registeredBaseUrl(policy, container, port);
  // Recorded before the container exists, so a crash mid-warm is cleaned up.
  await db
    .insertInto("sandbox_pool")
    .values({
      container_name: container,
      base_url: registered,
      session_api_key: key,
      policy_fingerprint: policyFingerprint(policy),
      config_fingerprint: configFingerprint(),
    })
    .execute();
  try {
    await docker(...sandboxRunArgs(policy, { container, key, hostPort: port, pool: true }));
    const baseUrl = await setupUrl(policy, container, registered);
    await waitReady(baseUrl, key);
    await configureSandbox(baseUrl, key, () => {});
    await db
      .updateTable("sandbox_pool")
      .set({ status: "READY", ready_at: new Date() })
      .where("container_name", "=", container)
      .execute();
    log(`pool sandbox ${container} ready`);
    return container;
  } catch (err) {
    await db.deleteFrom("sandbox_pool").where("container_name", "=", container).execute();
    await removeContainer(container);
    throw err;
  }
}

/**
 * Keeps the pool consistent with what is actually running: drops rows whose
 * container is gone or stuck warming, sandboxes from an older policy or
 * configuration, and labelled pool containers that belong to neither the
 * pool nor an organization (a handout interrupted by a crash).
 */
export async function reconcilePool(log: (message: string) => void = console.log) {
  const policy = loadSandboxPolicy();
  const current = { policy: policyFingerprint(policy), config: configFingerprint() };
  const stuckBefore = new Date(Date.now() - 10 * 60 * 1000);
  for (const row of await db.selectFrom("sandbox_pool").selectAll().execute()) {
    const running = (await docker("ps", "-q", "--filter", `name=^${row.container_name}$`)) !== "";
    const stale = row.policy_fingerprint !== current.policy || row.config_fingerprint !== current.config;
    const stuck = row.status === "WARMING" && row.created_at < stuckBefore;
    const gone = row.status === "READY" && !running;
    if (!stale && !stuck && !gone) continue;
    const removed = await db
      .deleteFrom("sandbox_pool")
      .where("container_name", "=", row.container_name)
      .where("status", "=", row.status)
      .executeTakeFirst();
    if (Number(removed.numDeletedRows) === 0) continue; // handed out meanwhile
    await removeContainer(row.container_name);
    log(`removed pool sandbox ${row.container_name} (${stale ? "outdated" : stuck ? "stuck warming" : "not running"})`);
  }

  const labelled = (await docker("ps", "-a", "--filter", "label=athernull.pool=1", "--format", "{{.Names}}")).split("\n").filter(Boolean);
  if (labelled.length === 0) return;
  const known = new Set([
    ...(await db.selectFrom("sandbox_pool").select("container_name").execute()).map((r) => r.container_name),
    ...(await db.selectFrom("org_agent_servers").select("container_name").execute()).map((r) => r.container_name),
  ]);
  for (const name of labelled) {
    if (known.has(name)) continue;
    await removeContainer(name);
    log(`removed orphaned pool container ${name}`);
  }
}

/** Sandboxes that count against SANDBOX_MAX_RUNNING: organizations' plus the pool's. */
export async function runningSandboxCount(): Promise<number> {
  const { orgs } = await db.selectFrom("org_agent_servers").select((eb) => eb.fn.countAll<string>().as("orgs")).executeTakeFirstOrThrow();
  const { pool } = await db.selectFrom("sandbox_pool").select((eb) => eb.fn.countAll<string>().as("pool")).executeTakeFirstOrThrow();
  return Number(orgs) + Number(pool);
}
