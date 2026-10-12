// Phase 0 (docs/architecture/CHAT_NATIVE_MIGRATION_PLAN.md §3) — how an
// org sandbox container is run: image, network, limits. Pure (env in,
// docker args out) so it is testable without Docker; provision.ts applies it.
//
// Production (Ubuntu VPS + Coolify, docs/runbooks/sandbox-network.md):
//   SANDBOX_NETWORK=athernull-sandboxes      dedicated bridge; no published ports
//   SANDBOX_NETWORK_POLICY=enforced          refuse to start without the host firewall
// Development (no SANDBOX_NETWORK): the old behaviour, a port published on
// 127.0.0.1, with the same image pin and limits.

import { createHash } from "node:crypto";

// The image the local stack has been running and verifying against
// (ghcr.io/openhands/agent-server latest-python, pulled 2026-09). Pinned by
// digest so a registry push can never change what runs (G0.4); move it on
// purpose, after the canvas smoke test passes against the new image.
export const DEFAULT_SANDBOX_IMAGE =
  "ghcr.io/openhands/agent-server@sha256:36e98f133e06b1078820a279566a4b0d27e65dac6497dc3dfa1efea4f3107bf5";

// Where the host firewall script (infrastructure/sandbox-network) records
// that its rules are in place for a network. /run is cleared on reboot, and
// the systemd unit re-applies the rules (and this marker) at boot.
export const FIREWALL_MARKER_DIR = "/run/athernull";

export interface SandboxPolicy {
  image: string;
  network: string | null;
  enforceFirewall: boolean;
  memory: string;
  cpus: string;
  pids: number;
  runtime: string | null;
  dropCaps: string[];
  dns: string[];
}

// Docker's default capability set minus what an agent workspace has no use
// for: NET_RAW (raw sockets / ARP spoofing on the shared bridge), MKNOD,
// AUDIT_WRITE, SETFCAP. Further drops need a run of the canvas smoke test.
const DEFAULT_DROP_CAPS = ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SETFCAP"];

// Public resolvers for sandboxes on the isolated network. Docker's embedded
// DNS forwards a container's queries from the container's own namespace, so
// the host's resolver (often a private or loopback address) is unreachable
// once private ranges are blocked; explicit public resolvers keep name
// resolution working the same on any VPS.
const DEFAULT_SANDBOX_DNS = ["1.1.1.1", "9.9.9.9"];

export class SandboxPolicyError extends Error {}

export function loadSandboxPolicy(env: NodeJS.ProcessEnv = process.env): SandboxPolicy {
  const image = env.SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  if (!/@sha256:[0-9a-f]{64}$/.test(image) && env.SANDBOX_ALLOW_UNPINNED_IMAGE !== "1") {
    throw new SandboxPolicyError(`SANDBOX_IMAGE must be pinned by digest (…@sha256:<64 hex>), got ${image}`);
  }
  const network = env.SANDBOX_NETWORK?.trim() || null;
  const enforceFirewall = env.SANDBOX_NETWORK_POLICY === "enforced";
  if (enforceFirewall && !network) {
    throw new SandboxPolicyError("SANDBOX_NETWORK_POLICY=enforced requires SANDBOX_NETWORK");
  }
  const pids = Number(env.SANDBOX_PIDS_LIMIT ?? 1024);
  if (!Number.isInteger(pids) || pids < 64) throw new SandboxPolicyError("SANDBOX_PIDS_LIMIT must be an integer ≥ 64");
  const memory = env.SANDBOX_MEMORY ?? "4g";
  if (!/^\d+[mg]$/.test(memory)) throw new SandboxPolicyError("SANDBOX_MEMORY must look like 4g or 2048m");
  const cpus = env.SANDBOX_CPUS ?? "2";
  if (!/^\d+(\.\d+)?$/.test(cpus) || Number(cpus) <= 0) throw new SandboxPolicyError("SANDBOX_CPUS must be a positive number");
  return {
    image,
    network,
    enforceFirewall,
    memory,
    cpus,
    pids,
    runtime: env.SANDBOX_RUNTIME?.trim() || null,
    dropCaps: DEFAULT_DROP_CAPS,
    dns: network ? parseDns(env.SANDBOX_DNS) : [],
  };
}

function parseDns(raw: string | undefined): string[] {
  const servers = (raw ?? DEFAULT_SANDBOX_DNS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of servers) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) throw new SandboxPolicyError(`SANDBOX_DNS entries must be IPv4 addresses, got ${s}`);
  }
  return servers;
}

/** `docker run` arguments for one org sandbox (everything after `docker`). */
export function sandboxRunArgs(policy: SandboxPolicy, opts: { container: string; key: string; hostPort: number | null }): string[] {
  const args = ["run", "-d", "--name", opts.container, "--restart", "unless-stopped"];
  args.push("--label", `athernull.sandbox-policy=${policyFingerprint(policy)}`);
  if (policy.network) {
    args.push("--network", policy.network);
    for (const server of policy.dns) args.push("--dns", server);
  } else {
    if (opts.hostPort === null) throw new SandboxPolicyError("a host port is required without SANDBOX_NETWORK");
    args.push("-p", `127.0.0.1:${opts.hostPort}:8000`);
  }
  args.push(
    "--memory", policy.memory,
    "--memory-swap", policy.memory,
    "--cpus", policy.cpus,
    "--pids-limit", String(policy.pids),
    "--security-opt", "no-new-privileges",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
  );
  for (const cap of policy.dropCaps) args.push("--cap-drop", cap);
  if (policy.runtime) args.push("--runtime", policy.runtime);
  args.push(
    "-e", `OH_SESSION_API_KEYS_0=${opts.key}`,
    "-v", `${opts.container}:/workspace`,
    policy.image, "--host", "0.0.0.0", "--port", "8000",
  );
  return args;
}

/**
 * Identifies the run policy (not the per-container key or port). A running
 * sandbox whose label differs is recreated — same named volume, so its
 * conversations survive — when it is next provisioned.
 */
export function policyFingerprint(policy: SandboxPolicy): string {
  const material = JSON.stringify([policy.image, policy.network, policy.memory, policy.cpus, policy.pids, policy.runtime, policy.dropCaps, policy.dns]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** The base URL the gateway and worker use to reach a sandbox. */
export function registeredBaseUrl(policy: SandboxPolicy, container: string, hostPort: number | null): string {
  return policy.network ? `http://${container}:8000` : `http://127.0.0.1:${hostPort}`;
}
