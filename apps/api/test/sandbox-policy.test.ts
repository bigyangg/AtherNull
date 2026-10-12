// Phase 0 — how org sandboxes are run (sandbox/policy.ts): pinned image,
// isolated network, resource limits. Pure: no Docker, no database.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_SANDBOX_IMAGE,
  loadSandboxPolicy,
  policyFingerprint,
  registeredBaseUrl,
  sandboxRunArgs,
  SandboxPolicyError,
} from "../src/sandbox/policy.js";

const PINNED = "ghcr.io/openhands/agent-server@sha256:" + "a".repeat(64);

function valueAfter(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
}

test("the default image is pinned by digest", () => {
  assert.match(DEFAULT_SANDBOX_IMAGE, /@sha256:[0-9a-f]{64}$/);
  assert.equal(loadSandboxPolicy({}).image, DEFAULT_SANDBOX_IMAGE);
});

test("a mutable image tag is refused unless explicitly allowed", () => {
  assert.throws(() => loadSandboxPolicy({ SANDBOX_IMAGE: "ghcr.io/openhands/agent-server:latest-python" }), SandboxPolicyError);
  assert.equal(
    loadSandboxPolicy({ SANDBOX_IMAGE: "x:latest", SANDBOX_ALLOW_UNPINNED_IMAGE: "1" }).image,
    "x:latest",
  );
});

test("an enforced network policy needs a network", () => {
  assert.throws(() => loadSandboxPolicy({ SANDBOX_NETWORK_POLICY: "enforced" }), SandboxPolicyError);
  const policy = loadSandboxPolicy({ SANDBOX_NETWORK: "athernull-sandboxes", SANDBOX_NETWORK_POLICY: "enforced" });
  assert.equal(policy.network, "athernull-sandboxes");
  assert.equal(policy.enforceFirewall, true);
});

test("limits and resolvers are validated", () => {
  assert.throws(() => loadSandboxPolicy({ SANDBOX_NETWORK: "n", SANDBOX_DNS: "dns.example" }), SandboxPolicyError);
  assert.throws(() => loadSandboxPolicy({ SANDBOX_MEMORY: "lots" }), SandboxPolicyError);
  assert.throws(() => loadSandboxPolicy({ SANDBOX_CPUS: "0" }), SandboxPolicyError);
  assert.throws(() => loadSandboxPolicy({ SANDBOX_PIDS_LIMIT: "10" }), SandboxPolicyError);
});

test("on the sandbox network: no published port, limits applied, reached by name", () => {
  const policy = loadSandboxPolicy({ SANDBOX_IMAGE: PINNED, SANDBOX_NETWORK: "athernull-sandboxes", SANDBOX_RUNTIME: "runsc" });
  const args = sandboxRunArgs(policy, { container: "athernull-sandbox-abc", key: "k", hostPort: null });
  assert.ok(!args.includes("-p"), "no port is published");
  assert.deepEqual(valueAfter(args, "--network"), ["athernull-sandboxes"]);
  assert.deepEqual(valueAfter(args, "--memory"), ["4g"]);
  assert.deepEqual(valueAfter(args, "--memory-swap"), ["4g"]);
  assert.deepEqual(valueAfter(args, "--cpus"), ["2"]);
  assert.deepEqual(valueAfter(args, "--pids-limit"), ["1024"]);
  assert.deepEqual(valueAfter(args, "--security-opt"), ["no-new-privileges"]);
  assert.ok(valueAfter(args, "--cap-drop").includes("NET_RAW"));
  assert.deepEqual(valueAfter(args, "--runtime"), ["runsc"]);
  assert.deepEqual(valueAfter(args, "--dns"), ["1.1.1.1", "9.9.9.9"], "public resolvers: the host's may be blocked");
  assert.equal(args.at(-5), PINNED, "the pinned image is what runs");
  assert.equal(registeredBaseUrl(policy, "athernull-sandbox-abc", null), "http://athernull-sandbox-abc:8000");
});

test("without a network (development): published on 127.0.0.1 only", () => {
  const policy = loadSandboxPolicy({});
  const args = sandboxRunArgs(policy, { container: "c", key: "k", hostPort: 41234 });
  assert.deepEqual(valueAfter(args, "-p"), ["127.0.0.1:41234:8000"]);
  assert.ok(!args.includes("--network"));
  assert.ok(!args.includes("--dns"), "development keeps Docker's default DNS");
  assert.equal(registeredBaseUrl(policy, "c", 41234), "http://127.0.0.1:41234");
  assert.throws(() => sandboxRunArgs(policy, { container: "c", key: "k", hostPort: null }), SandboxPolicyError);
});

test("the policy fingerprint changes with the policy, not with the key or port", () => {
  const a = loadSandboxPolicy({});
  const b = loadSandboxPolicy({ SANDBOX_MEMORY: "8g" });
  assert.notEqual(policyFingerprint(a), policyFingerprint(b));
  const one = sandboxRunArgs(a, { container: "c", key: "k1", hostPort: 1 });
  const two = sandboxRunArgs(a, { container: "c", key: "k2", hostPort: 2 });
  assert.deepEqual(valueAfter(one, "--label"), valueAfter(two, "--label"));
});
