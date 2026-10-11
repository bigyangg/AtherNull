// ADR-0015 — provision (or refresh) an organization's sandboxed OpenHands
// Agent Server: the backend the Agent Canvas reaches through apps/api's
// agent gateway, and where funded builds run as conversations.
//
//   pnpm --filter @athernull/api sandbox:provision -- --org <organizationId>
//
// Idempotent: reuses a registered, running sandbox and only re-applies its
// configuration. The container port is published on 127.0.0.1 only; the
// session key is generated here, stored for the gateway/worker, and never
// printed.
//
// Env: DATABASE_URL, NVIDIA_NIM_API_KEY (sandbox LLM for the canvas),
//      SANDBOX_IMAGE (default ghcr.io/openhands/agent-server:latest-python),
//      SANDBOX_LLM_MODEL (default nvidia_nim/nvidia/nemotron-3-super-120b-a12b)

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql } from "kysely";

import { db } from "../src/db.js";

const IMAGE = process.env.SANDBOX_IMAGE ?? "ghcr.io/openhands/agent-server:latest-python";
const LLM_MODEL = process.env.SANDBOX_LLM_MODEL ?? "nvidia_nim/nvidia/nemotron-3-super-120b-a12b";
const EXTENSION_DIR = fileURLToPath(new URL("../../canvas/extension/athernull/", import.meta.url));
const EXTENSION_REMOTE_DIR = "/workspace/.athernull/extensions/athernull";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
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

async function main() {
  const organizationId = arg("org");
  if (!organizationId) throw new Error("usage: provision-agent-sandbox --org <organizationId>");
  // Better Auth's tables are not in the Kysely schema types.
  const org = (await sql<{ id: string; name: string }>`select id, name from "organization" where id = ${organizationId}`.execute(db)).rows[0];
  if (!org) throw new Error(`organization ${organizationId} not found`);

  const container = `athernull-sandbox-${organizationId.slice(0, 8)}`;
  const existing = await db.selectFrom("org_agent_servers").selectAll().where("organization_id", "=", organizationId).executeTakeFirst();
  const running = docker("ps", "-q", "--filter", `name=^${container}$`) !== "";

  let baseUrl: string;
  let key: string;
  if (existing && running && existing.container_name === container) {
    baseUrl = existing.base_url;
    key = existing.session_api_key;
    console.log(`reusing ${container}`);
  } else {
    try {
      docker("rm", "-f", container);
    } catch {
      // nothing to remove
    }
    const port = await freePort();
    key = randomBytes(32).toString("hex");
    baseUrl = `http://127.0.0.1:${port}`;
    docker(
      "run", "-d", "--name", container, "--restart", "unless-stopped",
      "-p", `127.0.0.1:${port}:8000`,
      "-e", `OH_SESSION_API_KEYS_0=${key}`,
      "-v", `${container}:/workspace`,
      IMAGE, "--host", "0.0.0.0", "--port", "8000",
    );
    console.log(`started ${container} on 127.0.0.1:${port}`);
  }

  const info = await waitReady(baseUrl, key);
  await db
    .insertInto("org_agent_servers")
    .values({ organization_id: organizationId, base_url: baseUrl, session_api_key: key, container_name: container })
    .onConflict((oc) =>
      oc.column("organization_id").doUpdateSet({ base_url: baseUrl, session_api_key: key, container_name: container, updated_at: new Date() }),
    )
    .execute();
  console.log(`registered sandbox for "${org.name}" (agent-server ${info.version ?? "?"})`);

  // The canvas's own LLM (titles, readiness). Agent work itself is still
  // only reachable through a funded build — see agent-gateway/policy.ts.
  if (process.env.NVIDIA_NIM_API_KEY) {
    await call(baseUrl, key, "PATCH", "/api/settings", {
      agent_settings_diff: { llm: { model: LLM_MODEL, api_key: process.env.NVIDIA_NIM_API_KEY } },
    });
    console.log(`configured sandbox LLM ${LLM_MODEL}`);
  } else {
    console.log("NVIDIA_NIM_API_KEY not set: sandbox LLM left unconfigured");
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
  console.log("installed and enabled the AtherNull Builds extension");
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.destroy();
    process.exit(1);
  });
