import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { db } from "../db.js";
import { loadSandboxPolicy, SandboxPolicy, SandboxPolicyError } from "./policy.js";

const run = promisify(execFile);

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

function freshContainerName(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

export interface TaskSandboxConfig {
  taskId: string;
  orgId: string;
  projectId: string;
  memoryGB?: number;
  cpus?: number;
  pidsLimit?: number;
  networkMode: "isolated";
  image: string;
  env: Record<string, string>;
}

export interface TaskSandboxInfo {
  taskId: string;
  orgId: string;
  projectId: string;
  containerName: string;
  baseUrl: string;
  sessionApiKey: string;
  policy: SandboxPolicy;
  networkName: string;
  createdAt: Date;
}

const TASK_SANDBOX_LABEL = "athernull.task=true";

/**
 * Ensures an isolated Docker network exists for the organization.
 * Each org gets its own isolated network with no inter-container communication.
 */
async function ensureOrgNetwork(policy: SandboxPolicy, orgId: string): Promise<string> {
  const networkName = `athernull-org-${orgId.slice(0, 12)}`;
  
  // Check if network exists
  const networks = await docker("network", "ls", "--filter", `name=^${networkName}$`, "--format", "{{.Name}}");
  if (networks.trim() === networkName) {
    return networkName;
  }

  // Create isolated network: no ICC (inter-container communication), IP masquerade enabled
  await docker(
    "network", "create",
    "--driver", "bridge",
    "--opt", "com.docker.network.bridge.enable_icc=false",
    "--opt", "com.docker.network.bridge.enable_ip_masquerade=true",
    "--label", "athernull.org=true",
    networkName
  );
  
  return networkName;
}

/**
 * Creates a per-task sandbox with resource limits and network isolation.
 */
export async function provisionTaskSandbox(config: TaskSandboxConfig): Promise<TaskSandboxInfo> {
  const policy = loadSandboxPolicy();
  
  // Override policy with task-specific settings
  const taskPolicy: SandboxPolicy = {
    ...policy,
    image: config.image || policy.image,
    network: "isolated", // Will be overridden by custom network
    memory: `${config.memoryGB ?? 2}g`,
    cpus: String(config.cpus ?? 2),
    pids: config.pidsLimit ?? 512,
  };

  const networkName = await ensureOrgNetwork(taskPolicy, config.orgId);
  const containerName = freshContainerName(`athernull-task-${config.taskId}`);
  const sessionApiKey = randomBytes(32).toString("hex");

  // Build docker run args for per-task sandbox
  const args = [
    "run", "-d", "--name", containerName,
    "--restart", "no", // Per-task sandboxes don't auto-restart
    "--label", TASK_SANDBOX_LABEL,
    "--label", `athernull.task.id=${config.taskId}`,
    "--label", `athernull.task.org=${config.orgId}`,
    "--label", `athernull.task.project=${config.projectId}`,
    "--network", networkName,
    "--memory", taskPolicy.memory,
    "--memory-swap", taskPolicy.memory,
    "--cpus", taskPolicy.cpus,
    "--pids-limit", String(taskPolicy.pids),
    "--security-opt", "no-new-privileges",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "--dns", "1.1.1.1",
    "--dns", "9.9.9.9",
  ];

  // Drop capabilities
  for (const cap of taskPolicy.dropCaps) {
    args.push("--cap-drop", cap);
  }

  // Runtime if specified
  if (taskPolicy.runtime) {
    args.push("--runtime", taskPolicy.runtime);
  }

  // Environment variables (NO platform API keys!)
  args.push(
    "-e", `OH_SESSION_API_KEYS_0=${sessionApiKey}`,
    "-e", `ORG_ID=${config.orgId}`,
    "-e", `TASK_ID=${config.taskId}`,
    "-e", `PROJECT_ID=${config.projectId}`,
    "-e", `LLM_PROXY_URL=http://host.docker.internal:3001/internal/llm-proxy`,
    // Add custom env from config
    ...Object.entries(config.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  );

  // Volume for workspace (unique per task)
  const volumeName = `athernull-task-${config.taskId}`;
  args.push("-v", `${volumeName}:/workspace`);

  // Image and entrypoint
  args.push(taskPolicy.image, "--host", "0.0.0.0", "--port", "8000");

  await docker(...args);

  // Wait for sandbox to be ready
  const baseUrl = `http://${containerName}:8000`;
  await waitReady(baseUrl, sessionApiKey);

  // Configure sandbox (install extension, disable analytics, etc.)
  await configureTaskSandbox(baseUrl, sessionApiKey);

  // Store sandbox info in database
  await registerTaskSandbox(config.taskId, config.orgId, config.projectId, containerName, baseUrl, sessionApiKey, networkName, volumeName);

  return {
    taskId: config.taskId,
    orgId: config.orgId,
    projectId: config.projectId,
    containerName,
    baseUrl,
    sessionApiKey,
    policy: taskPolicy,
    networkName,
    createdAt: new Date(),
  };
}

async function waitReady(baseUrl: string, key: string, timeoutMs = 180000): Promise<void> {
  for (let i = 0; i < timeoutMs / 1000; i++) {
    try {
      const res = await fetch(`${baseUrl}/server_info`, {
        headers: { "X-Session-API-Key": key },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`task sandbox ${baseUrl} did not become ready within ${timeoutMs}ms`);
}

async function configureTaskSandbox(baseUrl: string, key: string): Promise<void> {
  // Disable analytics
  await callSandbox(baseUrl, key, "PATCH", "/api/settings", {
    misc_settings_diff: { app_preferences: { user_consents_to_analytics: false } },
  });

  // Install AtherNull Builds extension (if extension files exist)
  const EXTENSION_DIR = "/app/canvas/extension/athernull/"; // Adjust path as needed
  const EXTENSION_REMOTE_DIR = "/workspace/.athernull/extensions/athernull";
  
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    
    const extensionDir = fileURLToPath(new URL("../../../canvas/extension/athernull/", import.meta.url));
    
    if (fs.existsSync(extensionDir)) {
      for (const file of fs.readdirSync(extensionDir).sort()) {
        const formData = new FormData();
        formData.append("file", new Blob([fs.readFileSync(path.join(extensionDir, file))]), file);
        await callSandbox(baseUrl, key, "POST", "/api/file/upload", formData, { path: `${EXTENSION_REMOTE_DIR}/${file}` });
      }
      await callSandbox(baseUrl, key, "POST", "/api/canvas-extensions/install", {
        source: EXTENSION_REMOTE_DIR,
        force: true,
      });
      await callSandbox(baseUrl, key, "PATCH", "/api/canvas-extensions/installed/athernull", { enabled: true });
    }
  } catch (err) {
    console.warn(`Failed to install AtherNull extension in task sandbox: ${err}`);
  }
}

async function callSandbox(baseUrl: string, key: string, method: string, path: string, body?: unknown | FormData, query?: Record<string, string>): Promise<Response> {
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

async function registerTaskSandbox(
  taskId: string,
  orgId: string,
  projectId: string,
  containerName: string,
  baseUrl: string,
  sessionApiKey: string,
  networkName: string,
  volumeName: string,
): Promise<void> {
  await db
    .insertInto("task_sandboxes")
    .values({
      task_id: taskId,
      organization_id: orgId,
      project_id: projectId,
      container_name: containerName,
      base_url: baseUrl,
      session_api_key: sessionApiKey,
      network_name: networkName,
      volume_name: volumeName,
      status: "READY",
      created_at: new Date(),
    })
    .execute();
}

/**
 * Decommissions a task sandbox: stops container, removes volume, cleans up network if empty.
 */
export async function decommissionTaskSandbox(taskId: string): Promise<void> {
  const sandbox = await db
    .selectFrom("task_sandboxes")
    .selectAll()
    .where("task_id", "=", taskId)
    .executeTakeFirst();

  if (!sandbox) return;

  // Stop and remove container
  await removeContainer(sandbox.container_name);

  // Remove volume
  try {
    await docker("volume", "rm", sandbox.volume_name);
  } catch {
    // volume might not exist or be in use
  }

  // Check if network is empty and remove if so
  await maybeRemoveOrgNetwork(sandbox.network_name, sandbox.organization_id);

  // Update DB
  await db
    .updateTable("task_sandboxes")
    .set({ status: "DECOMMISSIONED", decommissioned_at: new Date() })
    .where("task_id", "=", taskId)
    .execute();
}

async function maybeRemoveOrgNetwork(networkName: string, orgId: string): Promise<void> {
  // Count remaining sandboxes on this network
  const count = await db
    .selectFrom("task_sandboxes")
    .select((eb) => eb.fn.countAll<string>().as("cnt"))
    .where("network_name", "=", networkName)
    .where("status", "=", "READY")
    .executeTakeFirstOrThrow();

  if (Number(count.cnt) === 0) {
    // No more sandboxes on this network, safe to remove
    try {
      await docker("network", "rm", networkName);
    } catch {
      // network might not exist or have other containers
    }
  }
}

/**
 * Gets sandbox info for a task.
 */
export async function getTaskSandbox(taskId: string): Promise<TaskSandboxInfo | null> {
  const row = await db
    .selectFrom("task_sandboxes")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("status", "=", "READY")
    .executeTakeFirst();

  if (!row) return null;

  return {
    taskId: row.task_id,
    orgId: row.organization_id,
    projectId: row.project_id,
    containerName: row.container_name,
    baseUrl: row.base_url,
    sessionApiKey: row.session_api_key,
    networkName: row.network_name,
    policy: loadSandboxPolicy(), // would need to store policy in DB for exact reconstruction
    createdAt: row.created_at,
  };
}