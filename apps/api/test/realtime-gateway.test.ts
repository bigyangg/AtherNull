// ADR-0007 Phase 3C — authenticated browser realtime viewing gateway tests.
// Follows relay.test.ts/openhands-compat.test.ts's exact idiom: a standalone
// file, inline helper functions (duplicated, not imported), a real Fastify
// app via inject()/injectWS(), and a real persistent Postgres test database
// (no reset/truncate between runs or suites).
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
const { executionBroadcaster } = await import("../src/realtime/execution-broadcaster.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (duplicated from openhands-compat.test.ts/relay.test.ts's
// fixtures, not imported, per this suite's own established convention) -----

const AUTH_ORIGIN = "http://localhost:3000";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN!;

class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies) this.cookies.set(c.name, c.value);
  }
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

async function addMemberDirect(organizationId: string, userId: string, role: string) {
  await sql`
    insert into "member" (id, "organizationId", "userId", role, "createdAt")
    values (gen_random_uuid(), ${organizationId}, ${userId}, ${role}, now())
  `.execute(db);
}

async function setActiveOrg(jar: CookieJar, organizationId: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie: jar.header, origin: AUTH_ORIGIN },
    payload: { organizationId },
  });
  assert.equal(res.statusCode, 200, `set-active failed: ${res.body}`);
  jar.absorb(res);
  jar.dropSessionCache();
}

async function removeMember(ownerJar: CookieJar, organizationId: string, memberIdOrEmail: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/organization/remove-member",
    headers: { cookie: ownerJar.header, origin: AUTH_ORIGIN },
    payload: { organizationId, memberIdOrEmail },
  });
  assert.equal(res.statusCode, 200, `remove-member failed: ${res.body}`);
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

function createJobPayload(projectId: string, agentProfileId: string) {
  return {
    projectId,
    repositoryRevision: "abc123",
    objective: "Add a health check endpoint",
    acceptanceCriteria: ["Returns 200"],
    agentProfileId,
    budgetMinor: 1000,
    currency: "usd",
  };
}

async function setUpOwnerWithOrg(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`rt-owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `RT Org ${suffix}`, `rt-org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

// Phase 4C: /fund now requires real provenance (see
// job-lifecycle.test.ts's createFundedTask, mirrored here exactly) —
// fixture-only insert of an APPROVED estimate + ACTIVE authorization,
// bypassing the planner LLM, then create + fund through the real HTTP
// endpoints.
function fakePlannerOutputForJobPayload(payload: ReturnType<typeof createJobPayload>) {
  return {
    goal: payload.objective,
    scope: { included: ["core feature set"], excluded: [] },
    deliverables: ["A deployed change"],
    implementationPlan: ["Implement the objective"],
    assumptions: [],
    acceptanceCriteria: payload.acceptanceCriteria,
    infrastructureRequirements: [],
    risks: [],
    resourceEstimate: {
      complexity: 0.5,
      estimatedDurationHours: { min: 1, max: 2 },
      inferenceRequirements: { estimatedTier: "standard" },
    },
  };
}

async function createFundedTask(
  owner: { jar: CookieJar; userId: string },
  organizationId: string,
  projectId: string,
  agentProfileId: string,
) {
  const payload = createJobPayload(projectId, agentProfileId);

  const estimate = await db
    .insertInto("project_estimates")
    .values({
      lineage_id: randomUUID(),
      version: 1,
      status: "APPROVED",
      organization_id: organizationId,
      project_id: projectId,
      source_prompt: "fixture prompt",
      planner_output: JSON.stringify(fakePlannerOutputForJobPayload(payload)),
      planner_model: "test-fixture",
      created_by: owner.userId,
      approved_by: owner.userId,
      approved_at: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const authorization = await db
    .insertInto("project_budget_authorizations")
    .values({
      organization_id: organizationId,
      project_id: projectId,
      estimate_id: estimate.id,
      estimate_lineage_id: estimate.lineage_id,
      estimate_version: estimate.version,
      amount_minor: String(payload.budgetMinor),
      currency: payload.currency,
      source: "USER_SET",
      status: "ACTIVE",
      authorized_by: owner.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  const created = await app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/tasks/from-budget-authorization`,
    headers: { cookie: owner.jar.header },
    payload: {
      budgetAuthorizationId: authorization.id,
      agentProfileId,
      repositoryRevision: payload.repositoryRevision,
    },
  });
  assert.equal(created.statusCode, 201, `canonical task creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;

  const funded = await app.inject({
    method: "POST",
    url: `/v1/jobs/${taskId}/fund`,
    headers: { cookie: owner.jar.header },
  });
  assert.equal(funded.statusCode, 200, `fund failed: ${funded.body}`);
  return taskId;
}

// Deliberately bypasses POST /internal/executions/claim's shared "oldest
// QUEUED task" queue entirely — Phase 3B's relay.test.ts (createRunningExecution)
// discovered that claiming-and-draining-stragglers under real concurrent
// load (this file runs as a separate process alongside
// job-lifecycle.test.ts/tenant-authorization.test.ts/openhands-compat.test.ts/
// relay.test.ts against one shared Postgres instance) can transiently steal
// another file's own in-flight task, or find the queue momentarily empty
// (a bare `claimed.statusCode` of 204, not 200, reproduced directly in this
// file's own first version). None of this file's tests need to exercise the
// claim FSM itself — they only need a real tasks/executions row pair already
// in the state a successful claim would have left it in. Inserting that
// state directly removes this suite from the shared queue entirely.
async function createRunningExecutionDirect(
  organizationId: string,
  projectId: string,
  agentProfileId: string,
): Promise<{ taskId: string; executionId: string; workerId: string }> {
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
      requirements: "realtime gateway test task",
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

  return { taskId: task.id, executionId: execution.id, workerId };
}

function messageEvent(text: string, source: "user" | "agent" = "agent") {
  return {
    id: randomUUID(),
    kind: "MessageEvent",
    occurredAt: new Date().toISOString(),
    payload: { source, llm_message: text, activated_skills: [], extended_content: [] },
  };
}

async function postExecutionEvents(executionId: string, workerId: string, events: ReturnType<typeof messageEvent>[]) {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/events`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, events },
  });
  assert.equal(res.statusCode, 204, `post events failed: ${res.body}`);
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

// Full fixture: an owner, their org, and a RUNNING task/execution (inserted
// directly — see createRunningExecutionDirect above), ready for a browser to
// subscribe to.
async function createRunningTaskForNewOrg(suffix: string) {
  const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
  const { taskId, executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);
  return { owner, organizationId, taskId, executionId, workerId };
}

function relayPath(executionId: string, workerId: string): string {
  return `/internal/relay/${executionId}?workerId=${encodeURIComponent(workerId)}`;
}

async function connectRelay(executionId: string, workerId: string): Promise<WebSocket> {
  return app.injectWS(relayPath(executionId, workerId), { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
}

function relayEventEnvelope(executionId: string, eventId: string, text = "hello") {
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

function realtimePath(id: string, executionIdQuery?: string): string {
  return `/v1/realtime/executions/${id}${executionIdQuery ? `?executionId=${encodeURIComponent(executionIdQuery)}` : ""}`;
}

type RealtimeMessage = { version: number; type: string; [key: string]: unknown };

// A thin client wrapper: collects every inbound frame (parsed JSON) so tests
// can assert against the full transcript, plus a `waitForType` helper for
// tests that only care about one message arriving eventually.
//
// The message listener MUST be attached via @fastify/websocket's injectWS
// `onInit` hook (fired the instant the client-side `ws` object is
// constructed, before the mocked upgrade handshake even starts) rather than
// after `injectWS()`'s returned promise resolves. This in-process test
// double resolves that promise from its own `ws.on('open', ...)` handler,
// but the server-side route handler in this suite sends `server.hello`
// (and, when relevant, `relay.unavailable`) SYNCHRONOUSLY, in the same tick
// the connection is accepted — a real browser's network round-trip always
// gives it time to attach a handler first, but this synchronous mock does
// not, so attaching the listener only after `await injectWS(...)` resolves
// non-deterministically misses the first frame(s). This is a property of
// the test harness, not of the gateway's real (production) behavior.
type InjectWSFn = (
  path: string,
  upgradeContext: { headers: Record<string, string> },
  options: { onInit: (ws: WebSocket) => void },
) => Promise<WebSocket>;

class RealtimeClient {
  readonly messages: RealtimeMessage[] = [];
  ws!: WebSocket;

  static async connect(
    appInstance: FastifyInstance,
    path: string,
    headers: Record<string, string>,
  ): Promise<RealtimeClient> {
    const client = new RealtimeClient();
    const injectWS = (appInstance as unknown as { injectWS: InjectWSFn }).injectWS.bind(appInstance);
    client.ws = await injectWS(path, { headers }, {
      onInit: (ws: WebSocket) => {
        ws.on("message", (data: Buffer) => {
          client.messages.push(JSON.parse(data.toString("utf8")) as RealtimeMessage);
        });
      },
    });
    return client;
  }

  async waitForType(type: string, timeoutMs = 3000): Promise<RealtimeMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`waitForType(${type}): timed out. Received so far: ${JSON.stringify(this.messages)}`);
  }

  eventIds(): string[] {
    const ids: string[] = [];
    for (const m of this.messages) {
      if (m.type === "history.ready") {
        for (const e of m.events as { id: string }[]) ids.push(e.id);
      }
      if (m.type === "execution.event") {
        ids.push((m.event as { id: string }).id);
      }
    }
    return ids;
  }

  close(): void {
    this.ws.close();
  }
}

async function connectRealtime(
  id: string,
  opts: { cookie?: string; origin?: string | null; executionIdQuery?: string } = {},
): Promise<RealtimeClient> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.origin !== undefined && opts.origin !== null) headers.origin = opts.origin;
  else if (opts.origin === undefined) headers.origin = AUTH_ORIGIN;
  return RealtimeClient.connect(app, realtimePath(id, opts.executionIdQuery), headers);
}

async function expectRealtimeRejected(
  id: string,
  opts: { cookie?: string; origin?: string | null },
  expectedStatus: number,
) {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.origin !== undefined && opts.origin !== null) headers.origin = opts.origin;
  else if (opts.origin === undefined) headers.origin = AUTH_ORIGIN;
  await assert.rejects(
    () => app.injectWS(realtimePath(id), { headers }),
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
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

// --- tests -------------------------------------------------------------

describe("realtime gateway: authentication and Origin", () => {
  test("1. a valid same-org authenticated user can subscribe", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    const client = await connectRealtime(taskId, { cookie: owner.jar.header });
    const hello = await client.waitForType("server.hello");
    assert.equal(hello.executionId, executionId);
    await client.waitForType("history.ready");
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("2. an unauthenticated user (no session cookie) is rejected", async () => {
    const suffix = randomUUID();
    const { taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    await expectRealtimeRejected(taskId, { cookie: undefined }, 401);
    await completeExecution(executionId, workerId);
  });

  test("3. a member removed from the org is rejected on a subsequent subscribe attempt", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);

    const memberEmail = `rt-removed-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Removed");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const { taskId, executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    // Sanity: works before removal.
    const before = await connectRealtime(taskId, { cookie: member.jar.header });
    await before.waitForType("server.hello");
    before.close();

    await removeMember(owner.jar, organizationId, memberEmail);

    await expectRealtimeRejected(taskId, { cookie: member.jar.header }, 403);
    await completeExecution(executionId, workerId);
  });

  test("4. cross-org execution access is rejected the same non-distinguishing way as a genuinely unknown id", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffixA);
    const { owner: ownerB } = await setUpOwnerWithOrg(suffixB);

    // Real cross-org task and a genuinely nonexistent id must both 404 —
    // same status, same body shape, no distinguishing signal.
    await expectRealtimeRejected(taskId, { cookie: ownerB.jar.header }, 404);
    await expectRealtimeRejected(randomUUID(), { cookie: ownerB.jar.header }, 404);

    // Pre-existing gap found while auditing the shared claim-queue race
    // (unrelated to this test's own assertions, which never needed
    // executionId/workerId before): this test's execution was left RUNNING
    // with a real lease and never completed. Once that lease expires it
    // becomes reclaimable by ANY test file's genuine claim-endpoint
    // coverage (POST /internal/executions/claim also picks up RUNNING tasks
    // whose lease has expired, not just QUEUED ones) — the same class of
    // shared-queue landmine as an uncompleted QUEUED row, just on a delay.
    // Complete it now that this test is done with it.
    await completeExecution(executionId, workerId);
  });

  test("5. a wrong Origin is rejected", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    await expectRealtimeRejected(taskId, { cookie: owner.jar.header, origin: "http://evil.example.com" }, 403);
    await completeExecution(executionId, workerId);
  });

  test("6. a missing Origin header is rejected (treated the same as a wrong one)", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    await expectRealtimeRejected(taskId, { cookie: owner.jar.header, origin: null }, 403);
    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: live delivery via the Phase 3B relay path", () => {
  test("7. an authorized subscriber receives a live event forwarded by the worker relay", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);

    const client = await connectRealtime(taskId, { cookie: owner.jar.header });
    await client.waitForType("history.ready");

    const relay = await connectRelay(executionId, workerId);
    const eventId = randomUUID();
    relay.send(JSON.stringify(relayEventEnvelope(executionId, eventId, "live via relay")));

    const delivered = await waitFor(() => {
      const found = client.messages.find(
        (m) => m.type === "execution.event" && (m.event as { id: string }).id === eventId,
      );
      return found ?? undefined;
    });
    assert.ok(delivered, "expected the relay-forwarded event to reach the browser gateway");

    relay.close();
    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: control messages are rejected explicitly", () => {
  // ADR-0007 Phase 3D note: this test originally connected as the task's
  // OWNER, under Phase 3C's own premise that NO connection had any
  // legitimate inbound message type at all. Phase 3D changed that premise —
  // owner/admin now hold realtime:control (session.ts's
  // hasRealtimeControlAuthority) — so an owner sending a control-shaped
  // message is no longer testing "a view-only connection rejects control,"
  // it would actually be testing "an authorized connection rejects an
  // UNRECOGNIZED command shape," a materially different assertion. This test
  // is updated to connect as a plain MEMBER instead — the actual Phase 3D
  // "no realtime:control" case this test's own name and describe-block
  // still describe — so its guarantee (a view-only connection's inbound
  // messages are always rejected, never silently accepted) is preserved
  // exactly, not weakened. Phase 3D's own realtime-control.test.ts covers
  // the owner/admin-authorized path this test no longer exercises.
  test("8. a browser without realtime:control sending a control-shaped message receives an explicit rejection, not silence", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const member = await signUpVerifiedAndSignIn(`rt-member-${suffix}@example.com`, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);
    void owner;

    const { taskId, executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);
    const client = await connectRealtime(taskId, { cookie: member.jar.header });
    await client.waitForType("history.ready");

    client.ws.send(
      JSON.stringify({ type: "chat.send", commandId: randomUUID(), executionId, payload: { text: "run rm -rf /" } }),
    );

    const error = await client.waitForType("error");
    assert.equal(error.code, "control_not_supported");

    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: dedupe and history<->live handoff invariants", () => {
  test("9. a duplicate event UUID delivered twice via the relay is rendered to the browser exactly once", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    const client = await connectRealtime(taskId, { cookie: owner.jar.header });
    await client.waitForType("history.ready");

    const relay = await connectRelay(executionId, workerId);
    const eventId = randomUUID();
    const envelope = relayEventEnvelope(executionId, eventId, "duplicate me");
    relay.send(JSON.stringify(envelope));
    relay.send(JSON.stringify(envelope));
    relay.send(JSON.stringify(envelope));

    await waitFor(() => (client.eventIds().includes(eventId) ? true : undefined));
    // Give any (incorrect) second delivery a chance to arrive before asserting.
    await new Promise((r) => setTimeout(r, 150));

    const occurrences = client.eventIds().filter((id) => id === eventId).length;
    assert.equal(occurrences, 1, "a duplicate event id must be rendered exactly once, never zero or more than one");

    relay.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("10. an event published during the history-fetch window is not lost (a real race, not a timing assumption)", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);

    const client = await RealtimeClient.connect(app, realtimePath(taskId), {
      cookie: owner.jar.header,
      origin: AUTH_ORIGIN,
    });

    // Published synchronously, in-process, immediately after the WS upgrade
    // resolves — the gateway's history query is a real network round trip to
    // Postgres (db.selectFrom(...).execute()), which cannot complete before
    // this synchronous call returns. This event is therefore guaranteed to
    // land inside the gateway's pre-history buffering window, never in
    // Postgres (nothing was inserted), and never in history.ready's own
    // list — the only way it can reach the client at all is through the
    // buffer-then-release mechanism under test.
    const raceEventId = randomUUID();
    executionBroadcaster.publishEvent(executionId, {
      id: raceEventId,
      kind: "MessageEvent",
      occurredAt: new Date().toISOString(),
      payload: { source: "agent", llm_message: "race window event" },
    });

    const historyReady = await client.waitForType("history.ready");
    const historyIds = (historyReady.events as { id: string }[]).map((e) => e.id);
    assert.ok(!historyIds.includes(raceEventId), "sanity: this event was never persisted, so history must not contain it");

    await waitFor(() => (client.eventIds().includes(raceEventId) ? true : undefined));
    const occurrences = client.eventIds().filter((id) => id === raceEventId).length;
    assert.equal(occurrences, 1, "the race-window event must be delivered exactly once, not dropped, not duplicated");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("11. an event that is both persisted (in history) and re-delivered live during the fetch window dedupes to one", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);

    // Persist it first, exactly like a real relay-then-HTTP double delivery
    // would (Phase 3B's own dedupe guarantee) — this row will be included in
    // history.ready.
    const sharedEventId = randomUUID();
    await postExecutionEvents(executionId, workerId, [messageEvent("in both history and the live buffer")]);
    const persistedEvent = await db
      .selectFrom("execution_events")
      .select(["id"])
      .where("execution_id", "=", executionId)
      .executeTakeFirstOrThrow();
    void persistedEvent;

    // Overwrite payload's id to a known value for a clean assertion — simpler
    // to just insert a second, purpose-built row directly.
    await db
      .insertInto("execution_events")
      .values({
        id: sharedEventId,
        execution_id: executionId,
        kind: "MessageEvent",
        payload: JSON.stringify({ source: "agent", llm_message: "shared id" }),
        occurred_at: new Date(),
      })
      .execute();

    const client = await RealtimeClient.connect(app, realtimePath(taskId), {
      cookie: owner.jar.header,
      origin: AUTH_ORIGIN,
    });

    // Re-published live, synchronously, during the same pre-history window
    // as test 10 — simulating the exact "arrived via relay again before
    // history load completed" scenario invariant 2 requires be safe.
    executionBroadcaster.publishEvent(executionId, {
      id: sharedEventId,
      kind: "MessageEvent",
      occurredAt: new Date().toISOString(),
      payload: { source: "agent", llm_message: "shared id" },
    });

    await client.waitForType("history.ready");
    await new Promise((r) => setTimeout(r, 150));

    const occurrences = client.eventIds().filter((id) => id === sharedEventId).length;
    assert.equal(occurrences, 1, "an id present in both history and the live buffer must still be rendered exactly once");

    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: relay-unavailable and completion", () => {
  test("12. a RUNNING execution with no active relay still serves history and surfaces relay.unavailable", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    await postExecutionEvents(executionId, workerId, [messageEvent("already persisted, no relay involved")]);

    const client = await connectRealtime(taskId, { cookie: owner.jar.header });
    const unavailable = await client.waitForType("relay.unavailable");
    assert.equal(unavailable.executionId, executionId);

    const history = await client.waitForType("history.ready");
    assert.equal((history.events as unknown[]).length, 1, "historical data must still be served with no relay present");

    // Must not hang or misreport completion — no execution.completed should
    // ever arrive for a still-RUNNING execution.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      !client.messages.some((m) => m.type === "execution.completed"),
      "an execution that has not completed must never receive execution.completed",
    );

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("13. execution completion triggers the final reconciliation signal and closes the socket", async () => {
    const suffix = randomUUID();
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);

    const client = await connectRealtime(taskId, { cookie: owner.jar.header });
    await client.waitForType("history.ready");
    const closed = waitForClose(client.ws);

    await postExecutionEvents(executionId, workerId, [messageEvent("final event before completion")]);
    await completeExecution(executionId, workerId, "success");

    const completedMsg = await client.waitForType("execution.completed");
    assert.equal(completedMsg.outcome, "success");
    assert.equal(completedMsg.finalEventCount, 1, "finalEventCount must match what is actually persisted in Postgres");

    const { code } = await closed;
    assert.equal(code, 1000, "a server-driven completion must close the socket cleanly");
  });
});

describe("realtime gateway: relay/execution resolution edge cases", () => {
  test("a task with no execution yet is rejected distinctly from not-found (not a security boundary, own-org data)", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const taskId = await createFundedTask(owner, organizationId, projectId, agentProfileId);
    await expectRealtimeRejected(taskId, { cookie: owner.jar.header }, 409);

    // taskId must stay QUEUED (unclaimed) for the assertion above — nothing
    // else in this suite ever claims/completes it, so left alone it would
    // sit QUEUED in the shared `tasks` table indefinitely: a landmine for
    // any other test file's genuine claim-endpoint coverage drawing from
    // the same shared FIFO queue (see job-lifecycle.test.ts's header
    // comment on this exact class of bug). Neutralize it now that the
    // assertion is done with it.
    await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", taskId).execute();
  });

  test("an executionId query mismatch against the resolved execution is rejected", async () => {
    const suffix = randomUUID();
    const { owner, taskId, workerId, executionId } = await createRunningTaskForNewOrg(suffix);
    const headers = { cookie: owner.jar.header, origin: AUTH_ORIGIN };
    await assert.rejects(() => app.injectWS(realtimePath(taskId, randomUUID()), { headers }), (err: Error) => {
      assert.ok(err.message.includes("409"));
      return true;
    });
    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: Phase 3B relay behavior is unaffected by the new fan-out wiring", () => {
  test("17. a relay registers, forwards an event, persists it, and disconnects — exactly like before Phase 3C", async () => {
    const suffix = randomUUID();
    const { taskId, executionId, workerId } = await createRunningTaskForNewOrg(suffix);
    void taskId;

    const relay = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId), "relay registration must still succeed unchanged");

    const eventId = randomUUID();
    relay.send(JSON.stringify(relayEventEnvelope(executionId, eventId, "still works")));
    const row = await waitFor(() =>
      db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).executeTakeFirst(),
    );
    assert.ok(row, "relay-forwarded events must still persist exactly as Phase 3B established");

    // terminate(), not close() — matches relay.test.ts's own established
    // convention (an abrupt drop is the reliably-detectable disconnect
    // signal in this in-process mocked-duplex-stream test harness; a
    // graceful close() is already exercised by the server-initiated closes
    // in the completion/replacement scenarios).
    relay.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    await completeExecution(executionId, workerId);
  });
});

describe("realtime gateway: static source-level safety assertions", () => {
  const files = [
    fileURLToPath(new URL("../src/routes/realtime-gateway.ts", import.meta.url)),
    fileURLToPath(new URL("../src/realtime/execution-broadcaster.ts", import.meta.url)),
    fileURLToPath(new URL("../../../packages/contracts/src/realtime-browser.ts", import.meta.url)),
  ];

  // Same convention as openhands-compat.test.ts's static assertions: strip
  // `//`/`/* */` comments before searching, so header/design commentary that
  // legitimately *names* these credentials (to document that the code must
  // never use them) doesn't trip a naive substring search against the
  // documentation itself — only the actual executable code is checked.
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }

  test("14. SESSION_API_KEY never appears in this phase's actual code, only in comments explaining why not", () => {
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      const codeOnly = stripComments(source);
      assert.ok(
        !codeOnly.includes("SESSION_API_KEY"),
        `${filePath} must never reference SESSION_API_KEY in code — it must never cross the worker/Agent-Server boundary`,
      );
    }
  });

  test("15. INTERNAL_API_TOKEN never appears in this phase's actual code, only in comments explaining why not", () => {
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      const codeOnly = stripComments(source);
      assert.ok(
        !codeOnly.includes("INTERNAL_API_TOKEN"),
        `${filePath} must never reference INTERNAL_API_TOKEN in code — the browser gateway has no business with the worker's credential`,
      );
    }
  });

  test("16. the browser realtime route never calls anything under /internal/*", () => {
    const routeFilePath = fileURLToPath(new URL("../src/routes/realtime-gateway.ts", import.meta.url));
    const source = readFileSync(routeFilePath, "utf8");
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
    assert.ok(
      source.includes("/internal/"),
      "sanity check: the file's documentation comment should still mention /internal/*",
    );
    assert.ok(
      !codeOnly.includes("/internal/"),
      "/internal/* must never appear in this file's actual code, only in comments explaining why not",
    );
  });
});
