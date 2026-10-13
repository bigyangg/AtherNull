// Workspace onboarding (docs/architecture/WORKSPACE_ONBOARDING.md): the
// workspace is requested at a verified user's sign-in, its progress is
// visible, one user cannot start unlimited sandboxes, and a warm-pool
// sandbox goes to exactly one new organization. Real Postgres; a local HTTP
// server stands in for a pool sandbox's agent server.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.SANDBOX_MAX_PER_USER = "3";

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { takePooledSandbox } = await import("../src/sandbox/provision.js");
const { createOrgAsOwner, signUpVerifiedAndSignIn, AUTH_ORIGIN } = await import("./support/app-fixtures.js");

let app: FastifyInstance;
let healthy: Server;
let healthyUrl: string;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
  // Answers /server_info for GOOD_KEY only.
  healthy = createServer((req, res) => {
    const ok = req.url === "/server_info" && req.headers["x-session-api-key"] === GOOD_KEY;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(ok ? '{"version":"test"}' : "{}");
  });
  await new Promise<void>((resolve) => healthy.listen(0, "127.0.0.1", resolve));
  healthyUrl = `http://127.0.0.1:${(healthy.address() as AddressInfo).port}`;
});

after(async () => {
  await db.deleteFrom("sandbox_pool").execute();
  await app.close();
  healthy.close();
});

beforeEach(async () => {
  await db.deleteFrom("sandbox_pool").execute();
});

const GOOD_KEY = "a".repeat(64);
const FP = { policy: "policy-fp", config: "config-fp" };
const reach = async (registered: string) => registered;
const quiet = () => {};

async function poolSandbox(opts: { baseUrl?: string; key?: string; policy?: string; config?: string; status?: string } = {}) {
  const name = `athernull-sandbox-${randomBytes(4).toString("hex")}`;
  await db
    .insertInto("sandbox_pool")
    .values({
      container_name: name,
      base_url: opts.baseUrl ?? healthyUrl,
      session_api_key: opts.key ?? GOOD_KEY,
      policy_fingerprint: opts.policy ?? FP.policy,
      config_fingerprint: opts.config ?? FP.config,
      status: opts.status ?? "READY",
      ready_at: new Date(),
    })
    .execute();
  return name;
}

async function newUser() {
  const user = await signUpVerifiedAndSignIn(app, `onboard-${randomUUID()}@example.com`, "correct horse battery", "Onboard");
  const member = await db.selectFrom("member").select("organizationId").where("userId", "=", user.userId).executeTakeFirstOrThrow();
  return { ...user, organizationId: member.organizationId };
}

const state = (cookie: string) => app.inject({ method: "GET", url: "/v1/agent-sandbox", headers: { cookie } });

describe("workspace requests", () => {
  test("a verified user's first sign-in already queues their workspace", async () => {
    const u = await newUser();
    const row = await db.selectFrom("agent_sandbox_requests").selectAll().where("organization_id", "=", u.organizationId).executeTakeFirst();
    assert.ok(row, "requested at sign-in");
    assert.equal(row.status, "PENDING");
    assert.equal(row.requested_by, u.userId);
    const res = await state(u.jar.header);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "PENDING");
    assert.equal(body.phase, "QUEUED");
    assert.equal(typeof body.queuePosition, "number");
  });

  test("the queue position counts the workspaces requested earlier", async () => {
    const first = await newUser();
    const second = await newUser();
    const a = JSON.parse((await state(first.jar.header)).body);
    const b = JSON.parse((await state(second.jar.header)).body);
    assert.equal(b.queuePosition, a.queuePosition + 1);
  });

  test("a ready pool sandbox is announced as a quick start", async () => {
    const u = await newUser();
    // First in line (the shared test database holds other tests' requests).
    await db
      .updateTable("agent_sandbox_requests")
      .set({ requested_at: new Date(0) })
      .where("organization_id", "=", u.organizationId)
      .execute();
    assert.equal(JSON.parse((await state(u.jar.header)).body).quickStart, false);
    await poolSandbox({ status: "WARMING" });
    assert.equal(JSON.parse((await state(u.jar.header)).body).quickStart, false, "warming does not count");
    await poolSandbox();
    assert.equal(JSON.parse((await state(u.jar.header)).body).quickStart, true);
  });

  test("provisioner failures reach the customer as a plain message, never operator detail", async () => {
    const u = await newUser();
    await db
      .updateTable("agent_sandbox_requests")
      .set({ status: "FAILED", error: "docker: /var/run/docker.sock permission denied (10.0.0.1)" })
      .where("organization_id", "=", u.organizationId)
      .execute();
    const body = JSON.parse((await state(u.jar.header)).body);
    assert.equal(body.status, "FAILED");
    assert.doesNotMatch(body.error, /docker|sock|10\.0\.0\.1/);
    // Asking again retries it.
    const retry = await app.inject({ method: "POST", url: "/v1/agent-sandbox", headers: { cookie: u.jar.header } });
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(JSON.parse(retry.body).status, "PENDING");
  });

  test("one user cannot start unlimited workspaces by creating organizations", async () => {
    const u = await newUser(); // 1: their personal workspace, at sign-in
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      await createOrgAsOwner(app, u.jar, `Extra ${i}`, `extra-${randomUUID().slice(0, 8)}`);
      const res = await app.inject({ method: "POST", url: "/v1/agent-sandbox", headers: { cookie: u.jar.header, origin: AUTH_ORIGIN } });
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [202, 202, 429]);
  });
});

describe("warm pool handout", () => {
  test("a ready, current pool sandbox is registered to the new organization and leaves the pool", async () => {
    const u = await newUser();
    const name = await poolSandbox();
    const got = await takePooledSandbox(u.organizationId, FP, reach, quiet);
    assert.ok(got);
    assert.equal(got.container, name);
    assert.equal(await db.selectFrom("sandbox_pool").select("container_name").where("container_name", "=", name).executeTakeFirst(), undefined);
    const server = await db.selectFrom("org_agent_servers").selectAll().where("organization_id", "=", u.organizationId).executeTakeFirstOrThrow();
    assert.equal(server.container_name, name);
    assert.equal(server.session_api_key, GOOD_KEY);
  });

  test("sandboxes from another policy or configuration, or still warming, are never handed out", async () => {
    const u = await newUser();
    await poolSandbox({ policy: "old-policy" });
    await poolSandbox({ config: "old-config" });
    await poolSandbox({ status: "WARMING" });
    assert.equal(await takePooledSandbox(u.organizationId, FP, reach, quiet), null);
  });

  test("an unhealthy pool sandbox is dropped and the next one is used", async () => {
    const u = await newUser();
    const dead = await poolSandbox({ key: "f".repeat(64) });
    await new Promise((r) => setTimeout(r, 5));
    const alive = await poolSandbox();
    const got = await takePooledSandbox(u.organizationId, FP, reach, quiet);
    assert.equal(got?.container, alive);
    assert.equal(await db.selectFrom("sandbox_pool").select("container_name").where("container_name", "=", dead).executeTakeFirst(), undefined);
  });

  test("one pool sandbox goes to exactly one of two organizations asking at once", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const name = await poolSandbox();
    const results = await Promise.all([
      takePooledSandbox(a.organizationId, FP, reach, quiet),
      takePooledSandbox(b.organizationId, FP, reach, quiet),
    ]);
    assert.equal(results.filter(Boolean).length, 1, "handed out once");
    const owners = await db.selectFrom("org_agent_servers").select("organization_id").where("container_name", "=", name).execute();
    assert.equal(owners.length, 1);
  });
});
