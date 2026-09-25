// ADR-0007 Phase 3B — worker -> apps/api outbound relay tunnel tests.
// Follows openhands-compat.test.ts/job-lifecycle.test.ts's exact idiom: a
// standalone file, inline helper functions (duplicated, not imported), a
// real Fastify app via inject()/injectWS(), and a real persistent Postgres
// test database (no reset/truncate between runs or suites).
//
// injectWS() (from @fastify/websocket) drives the WebSocket upgrade entirely
// in-process over fake duplex streams, exactly like inject() does for plain
// HTTP — no real port is bound, matching this suite's existing style.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";
import type { WebSocket } from "ws";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { relayRegistry } = await import("../src/realtime/relay-registry.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (duplicated from openhands-compat.test.ts's fixtures, not
// imported, per this suite's own established convention) ------------------

const AUTH_ORIGIN = "http://localhost:3000";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies) this.cookies.set(c.name, c.value);
  }
  // /organization/create updates activeOrganizationId in the DB but does not
  // reissue cookies, so the signed 5-minute session_data cache cookie would
  // otherwise keep resolving to the pre-creation (no active org) session.
  dropSessionCache(): void {
    this.cookies.delete("better-auth.session_data");
  }
  get header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function signUpVerifiedAndSignIn(email: string, password: string, name: string) {
  const signUpRes = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: AUTH_ORIGIN },
    payload: { email, password, name },
  });
  assert.equal(signUpRes.statusCode, 200, `sign-up failed: ${signUpRes.body}`);
  await sql`update "user" set "emailVerified" = true where "email" = ${email}`.execute(db);

  const signInRes = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: AUTH_ORIGIN },
    payload: { email, password },
  });
  assert.equal(signInRes.statusCode, 200, `sign-in failed: ${signInRes.body}`);

  const jar = new CookieJar();
  jar.absorb(signInRes);
  const userId = (JSON.parse(signInRes.body) as { user: { id: string } }).user.id;
  return { jar, userId };
}

async function createOrgAsOwner(jar: CookieJar, name: string, slug: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie: jar.header, origin: AUTH_ORIGIN },
    payload: { name, slug },
  });
  assert.equal(res.statusCode, 200, `create-org failed: ${res.body}`);
  jar.absorb(res);
  jar.dropSessionCache();
  return (JSON.parse(res.body) as { id: string }).id;
}

async function seedProjectAndAgentProfile(organizationId: string, ownerUserId: string) {
  const project = await db
    .insertInto("projects")
    .values({
      organization_id: organizationId,
      permitted_repository: "github.com/athernull/example",
      owner_user_id: ownerUserId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const agentProfile = await db
    .insertInto("agent_profiles")
    .values({
      organization_id: organizationId,
      model_tiers: JSON.stringify([{ tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 1 }]),
      policy_version: "v1",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { projectId: project.id, agentProfileId: agentProfile.id };
}

// One shared org/project/agent-profile fixture for the whole suite — relay
// tests only need real `tasks`/`executions` rows to exercise the lease
// primitive, they don't exercise per-test tenant isolation (that's already
// covered by tenant-authorization.test.ts/openhands-compat.test.ts), so
// there's no need to spin up a fresh org per test.
let fixture: { organizationId: string; projectId: string; agentProfileId: string } | null = null;
async function getFixture() {
  if (fixture) return fixture;
  const suffix = randomUUID();
  const owner = await signUpVerifiedAndSignIn(`relay-owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Relay Org ${suffix}`, `relay-org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  fixture = { organizationId, projectId, agentProfileId };
  return fixture;
}

// Deliberately bypasses POST /internal/executions/claim: that endpoint pulls
// from the single, globally shared "oldest QUEUED task" queue
// (`internal.ts`'s `FOR UPDATE SKIP LOCKED` query), and this test file's own
// job-lifecycle.test.ts/tenant-authorization.test.ts/openhands-compat.test.ts
// siblings run concurrently as separate processes against that same shared
// Postgres instance. An earlier version of this fixture called claim() and
// "drained" (auto-completed) any non-matching task it happened to pick up —
// which, under real concurrent load, occasionally stole and completed a
// task another test file's own assertion was still relying on staying
// QUEUED. Relay tests don't need to exercise the claim FSM at all (that's
// already covered by job-lifecycle.test.ts/tenant-authorization.test.ts) —
// they only need a real `executions` row already in the state a successful
// claim would have left it in. Inserting that state directly removes this
// suite from the shared claim queue entirely: it can never take another
// file's task, and (since lease_expires_at is set safely in the future)
// nothing else can reclaim this one either.
async function createRunningExecution(): Promise<{ executionId: string; workerId: string; taskId: string }> {
  const { organizationId, projectId, agentProfileId } = await getFixture();
  const workerId = `worker-${randomUUID()}`;

  const task = await db
    .insertInto("tasks")
    .values({
      organization_id: organizationId,
      project_id: projectId,
      agent_profile_id: agentProfileId,
      repository_revision: "abc123",
      agent_profile_config_revision: 1,
      agent_policy_version: "v1",
      requirements: "relay test task",
      acceptance_criteria: JSON.stringify(["n/a"]),
      max_budget_minor: "1000",
      currency: "usd",
      status: "RUNNING",
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const execution = await db
    .insertInto("executions")
    .values({
      task_id: task.id,
      lease_owner: workerId,
      lease_expires_at: sql`now() + make_interval(secs => 300)`,
      status: "RUNNING",
      started_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return { executionId: execution.id, workerId, taskId: task.id };
}

async function completeExecution(executionId: string, workerId: string, outcome: "success" | "failure" = "success") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/complete`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, outcome },
  });
  assert.equal(res.statusCode, 200, `complete failed: ${res.body}`);
}

function relayPath(executionId: string, workerId: string): string {
  return `/internal/relay/${executionId}?workerId=${encodeURIComponent(workerId)}`;
}

async function connectRelay(
  executionId: string,
  workerId: string,
  token: string | undefined = INTERNAL_TOKEN,
): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return app.injectWS(relayPath(executionId, workerId), { headers });
}

async function expectRelayRejected(executionId: string, workerId: string, token: string | undefined, expectedStatus: number) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  await assert.rejects(
    () => app.injectWS(relayPath(executionId, workerId), { headers }),
    (err: Error) => {
      assert.ok(
        err.message.includes(String(expectedStatus)),
        `expected rejection to mention status ${expectedStatus}, got: ${err.message}`,
      );
      return true;
    },
  );
}

function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor: timed out");
}

function executionEventEnvelope(executionId: string, eventId: string, text = "hello") {
  return {
    version: 1,
    type: "execution.event" as const,
    executionId,
    eventId,
    payload: {
      id: eventId,
      kind: "MessageEvent",
      occurredAt: new Date().toISOString(),
      payload: { source: "agent", llm_message: text },
    },
  };
}

// --- tests -----------------------------------------------------------------

describe("relay: registration authentication and lease verification", () => {
  test("valid token + correct workerId + RUNNING execution succeeds", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId), "expected the relay to be registered");
    ws.close();
    await completeExecution(executionId, workerId);
  });

  test("missing/invalid INTERNAL_API_TOKEN is rejected", async () => {
    const { executionId, workerId } = await createRunningExecution();
    await expectRelayRejected(executionId, workerId, undefined, 401);
    await expectRelayRejected(executionId, workerId, "wrong-token", 401);
    assert.equal(relayRegistry.get(executionId), undefined);
    await completeExecution(executionId, workerId);
  });

  test("workerId that does not match the execution's lease_owner is rejected", async () => {
    const { executionId, workerId } = await createRunningExecution();
    await expectRelayRejected(executionId, "someone-else", INTERNAL_TOKEN, 409);
    assert.equal(relayRegistry.get(executionId), undefined);
    await completeExecution(executionId, workerId);
  });

  test("an unknown/nonexistent executionId is rejected", async () => {
    await expectRelayRejected(randomUUID(), "worker-x", INTERNAL_TOKEN, 404);
  });

  test("a non-RUNNING execution is rejected", async () => {
    const { executionId, workerId } = await createRunningExecution();
    await completeExecution(executionId, workerId);
    // lease_owner is unchanged (immutable per row) but status is now
    // SUCCEEDED, not RUNNING.
    await expectRelayRejected(executionId, workerId, INTERNAL_TOKEN, 409);
  });
});

describe("relay: registry — one active relay per execution, replacement policy", () => {
  test("a second registration for the same execution replaces the first, closing it", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const first = await connectRelay(executionId, workerId);
    const firstClosed = waitForClose(first);

    const second = await connectRelay(executionId, workerId);

    const { code } = await firstClosed;
    assert.equal(code, 4000, "the replaced connection must be closed with the documented replacement code");
    assert.equal(relayRegistry.size >= 1, true);
    assert.ok(relayRegistry.get(executionId), "expected exactly one relay still registered for this execution");

    second.close();
    await completeExecution(executionId, workerId);
  });
});

describe("relay: lifecycle — disconnect and completion remove the registration", () => {
  test("a worker disconnect removes the registration", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId));

    // terminate() (an abrupt drop, no close handshake) rather than close()
    // (a graceful handshake) — this is also the more representative
    // simulation of "disconnect detection" (ADR-0007's required transport
    // property): a real worker process dying or losing network looks like
    // this, not a clean close. The graceful-close path is exercised by the
    // server-initiated closes in the completion/replacement tests above.
    ws.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    await completeExecution(executionId, workerId);
  });

  test("execution completion removes the registration and closes the socket", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId));
    const closed = waitForClose(ws);

    await completeExecution(executionId, workerId);

    const { code } = await closed;
    assert.equal(code, 4001, "completion must close the relay with the documented server-initiated code");
    assert.equal(relayRegistry.get(executionId), undefined);
  });
});

describe("relay: event forwarding and persistence dedupe", () => {
  test("an execution.event envelope sent by a registered worker is persisted", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    const eventId = randomUUID();

    ws.send(JSON.stringify(executionEventEnvelope(executionId, eventId, "hello from the relay")));

    const row = await waitFor(() =>
      db.selectFrom("execution_events").select(["id", "execution_id"]).where("id", "=", eventId).executeTakeFirst(),
    );
    assert.equal(row.execution_id, executionId);

    ws.close();
    await completeExecution(executionId, workerId);
  });

  test("duplicate event ids arriving via the relay (and via the HTTP path) create exactly one row", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    const eventId = randomUUID();
    const envelope = executionEventEnvelope(executionId, eventId, "duplicate me");

    // Sent three times over the relay, plus once more via the authoritative
    // HTTP path (as EventForwarder's own batched flush would independently
    // do for the same event) — all four must collapse to one row.
    ws.send(JSON.stringify(envelope));
    ws.send(JSON.stringify(envelope));
    ws.send(JSON.stringify(envelope));
    await waitFor(() =>
      db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).executeTakeFirst(),
    );

    await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/events`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        workerId,
        events: [{ id: eventId, kind: "MessageEvent", occurredAt: envelope.payload.occurredAt, payload: envelope.payload.payload }],
      },
    });

    const rows = await db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).execute();
    assert.equal(rows.length, 1, "a duplicate event id must never create a second persistence identity");

    ws.close();
    await completeExecution(executionId, workerId);
  });

  test("a malformed message does not crash the connection — a later valid event still persists", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);

    ws.send("not json at all");
    ws.send(JSON.stringify({ version: 1, type: "not-a-real-type", executionId, payload: {} }));
    ws.send(JSON.stringify({ version: 2, type: "execution.event", executionId, eventId: "x", payload: {} }));

    const eventId = randomUUID();
    ws.send(JSON.stringify(executionEventEnvelope(executionId, eventId)));

    const row = await waitFor(() =>
      db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).executeTakeFirst(),
    );
    assert.ok(row, "a valid event sent after malformed ones must still persist — the socket must not be dropped");

    ws.close();
    await completeExecution(executionId, workerId);
  });
});

describe("relay: failure isolation — the normal execution/persistence path is unaffected", () => {
  test("an abruptly terminated relay does not fail the ordinary claim -> events -> complete flow", async () => {
    const { executionId, workerId } = await createRunningExecution();
    const ws = await connectRelay(executionId, workerId);
    ws.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    const eventId = randomUUID();
    const eventsRes = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/events`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        workerId,
        events: [{ id: eventId, kind: "MessageEvent", occurredAt: new Date().toISOString(), payload: { text: "still works" } }],
      },
    });
    assert.equal(eventsRes.statusCode, 204, "event persistence must succeed regardless of relay state");

    const row = await db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).executeTakeFirst();
    assert.ok(row, "event must be persisted via the HTTP path even though the relay was already dead");

    await completeExecution(executionId, workerId);
  });

  test("no relay ever registered at all does not block claim -> events -> complete", async () => {
    const { executionId, workerId } = await createRunningExecution();
    // Never connect a relay for this execution — gateway-unreachable-at-
    // registration-time is indistinguishable from "never tried" as far as
    // the dispatch/persistence path is concerned.
    const eventsRes = await app.inject({
      method: "POST",
      url: `/internal/executions/${executionId}/events`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        workerId,
        events: [{ id: randomUUID(), kind: "MessageEvent", occurredAt: new Date().toISOString(), payload: {} }],
      },
    });
    assert.equal(eventsRes.statusCode, 204);
    await completeExecution(executionId, workerId);
  });
});

describe("relay: static source-level safety assertions", () => {
  const files = ["relay.ts", "../realtime/relay-registry.ts", "../realtime/envelope.ts", "../execution-events.ts"].map(
    (rel) => fileURLToPath(new URL(`../src/routes/${rel}`, import.meta.url)),
  );

  test("SESSION_API_KEY never appears anywhere in the relay/registry/envelope source", () => {
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      assert.ok(
        !source.includes("SESSION_API_KEY"),
        `${filePath} must never reference SESSION_API_KEY — it must never cross the worker/Agent-Server boundary`,
      );
    }
  });
});
