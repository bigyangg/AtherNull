// Integration + unit tests for the OpenHands-compatible read surface
// (apps/api/src/routes/openhands-compat.ts, packages/contracts/src/openhands-compat.ts).
// Follows job-lifecycle.test.ts/tenant-authorization.test.ts's exact idiom: a
// standalone file, inline helper functions (duplicated, not imported), a real
// Fastify app via inject(), and a real persistent Postgres test database with
// randomUUID()-suffixed isolation (no reset/truncate between runs or suites).
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

import { parseAtherNullTags, serializeAtherNullTags } from "@athernull/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { sql } from "kysely";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { resolveConversationTarget } = await import("../src/routes/openhands-compat.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (mirrors tenant-authorization.test.ts / job-lifecycle.test.ts) ---

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
      model_tiers: JSON.stringify([
        { tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 1 },
      ]),
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
  const owner = await signUpVerifiedAndSignIn(`owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `Org ${suffix}`, `org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

// Creates + funds a task as the owner, returning its id without claiming it
// (used for the "zero executions yet" case).
async function createFundedTask(ownerCookie: string, projectId: string, agentProfileId: string) {
  const created = await app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { cookie: ownerCookie },
    payload: createJobPayload(projectId, agentProfileId),
  });
  assert.equal(created.statusCode, 201, `job creation failed: ${created.body}`);
  const taskId = (JSON.parse(created.body) as { id: string }).id;

  const funded = await app.inject({
    method: "POST",
    url: `/v1/jobs/${taskId}/fund`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(funded.statusCode, 200, `fund failed: ${funded.body}`);
  return taskId;
}

// Claims whichever task the internal /claim endpoint hands back, draining any
// stragglers left over by other tests/suites sharing this persistent DB
// (identical pattern to job-lifecycle.test.ts's createFundedAndRunningTask),
// until it returns the caller's own taskId. Unlike that helper, this stops
// right after claiming — it does NOT complete the execution — so the caller
// can report a conversation id / post events first.
async function claimOwnTaskExecution(taskId: string): Promise<{ executionId: string; workerId: string }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const workerId = `worker-${randomUUID()}`;
    const claimed = await app.inject({
      method: "POST",
      url: "/internal/executions/claim",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId },
    });
    assert.equal(claimed.statusCode, 200, `claim failed: ${claimed.body}`);
    const body = JSON.parse(claimed.body) as { jobId: string; executionId: string };

    if (body.jobId === taskId) {
      return { executionId: body.executionId, workerId };
    }

    // Not ours — a straggler from another test. Drain it with a "success"
    // complete so it stops clogging the claim queue, then keep looping.
    const drained = await app.inject({
      method: "POST",
      url: `/internal/executions/${body.executionId}/complete`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: { workerId, outcome: "success" },
    });
    assert.equal(drained.statusCode, 200, `drain complete failed: ${drained.body}`);
  }
  throw new Error("claim never returned this test's own task within 50 attempts");
}

async function reportConversation(executionId: string, workerId: string, conversationId: string) {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/conversation`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, conversationId },
  });
  assert.equal(res.statusCode, 200, `report conversation failed: ${res.body}`);
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

async function completeExecution(executionId: string, workerId: string, outcome: "success" | "failure") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/complete`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, outcome },
  });
  assert.equal(res.statusCode, 200, `complete failed: ${res.body}`);
  return JSON.parse(res.body) as { status: string };
}

// Full happy-path fixture: create -> fund -> claim -> report conversation ->
// post events -> complete. Returns everything a test needs to assert against
// the OpenHands-compatible read surface for this one execution attempt.
async function createFundedAndRunningTaskWithConversation(
  ownerCookie: string,
  projectId: string,
  agentProfileId: string,
  opts: { events?: ReturnType<typeof messageEvent>[]; completeOutcome?: "success" | "failure" } = {},
) {
  const taskId = await createFundedTask(ownerCookie, projectId, agentProfileId);
  const { executionId, workerId } = await claimOwnTaskExecution(taskId);
  const conversationId = `oh-conv-${randomUUID()}`;
  await reportConversation(executionId, workerId, conversationId);

  const events = opts.events ?? [messageEvent("hello from the agent")];
  await postExecutionEvents(executionId, workerId, events);

  const outcomeResult = await completeExecution(executionId, workerId, opts.completeOutcome ?? "success");

  return { taskId, executionId, workerId, conversationId, events, taskStatus: outcomeResult.status };
}

// --- tests -----------------------------------------------------------------

describe("openhands-compat: tenant-scoped conversation reads", () => {
  test("a same-org member can read a conversation via search and the events endpoints", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);

    const memberEmail = `member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const events = [messageEvent("first"), messageEvent("second")];
    const { taskId, conversationId, taskStatus } = await createFundedAndRunningTaskWithConversation(
      owner.jar.header,
      projectId,
      agentProfileId,
      { events },
    );
    assert.equal(taskStatus, "VERIFYING", "a successful completion must move the task to VERIFYING");

    const searchRes = await app.inject({
      method: "GET",
      url: "/api/conversations/search",
      headers: { cookie: member.jar.header },
    });
    assert.equal(searchRes.statusCode, 200, `search failed: ${searchRes.body}`);
    const searchBody = JSON.parse(searchRes.body) as { items: { id: string; tags?: string[] }[] };
    const found = searchBody.items.find((item) => item.id === conversationId);
    assert.ok(found, `expected conversation ${conversationId} in same-org member's search results`);
    assert.ok(found.tags?.includes("athernull:task-status:VERIFYING"), "expected the VERIFYING status tag");

    const countRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/events/count`,
      headers: { cookie: member.jar.header },
    });
    assert.equal(countRes.statusCode, 200, `events count failed: ${countRes.body}`);
    assert.equal(JSON.parse(countRes.body), events.length);

    const searchEventsRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/events/search`,
      headers: { cookie: member.jar.header },
    });
    assert.equal(searchEventsRes.statusCode, 200, `events search failed: ${searchEventsRes.body}`);
    const eventsBody = JSON.parse(searchEventsRes.body) as { items: { id: string }[] };
    assert.equal(eventsBody.items.length, events.length);
    assert.deepEqual(
      eventsBody.items.map((e) => e.id).sort(),
      events.map((e) => e.id).sort(),
    );

    void taskId;
  });

  test("a user from a different organization cannot resolve it (null result, not an error)", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId, agentProfileId } = await setUpOwnerWithOrg(suffixA);
    const { owner: ownerB } = await setUpOwnerWithOrg(suffixB);

    const { conversationId } = await createFundedAndRunningTaskWithConversation(
      ownerA.jar.header,
      projectId,
      agentProfileId,
    );

    // Batch endpoint: cross-org id must resolve to null in-place, not throw
    // and not reveal whether the id exists at all.
    const batchRes = await app.inject({
      method: "GET",
      url: `/api/conversations?ids[]=${encodeURIComponent(conversationId)}`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(batchRes.statusCode, 200, `batch failed: ${batchRes.body}`);
    assert.deepEqual(JSON.parse(batchRes.body), [null]);

    // Events count/search must degrade to the same "not started/not found"
    // shape as a genuinely unknown id — never a distinguishing error.
    const countRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/events/count`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(countRes.statusCode, 200);
    assert.equal(JSON.parse(countRes.body), 0);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}/events/search`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(eventsRes.statusCode, 200);
    assert.deepEqual(JSON.parse(eventsRes.body), { items: [], next_page_id: null });

    // Org B's own search results must not leak org A's conversation either.
    const searchRes = await app.inject({
      method: "GET",
      url: "/api/conversations/search",
      headers: { cookie: ownerB.jar.header },
    });
    const searchBody = JSON.parse(searchRes.body) as { items: { id: string }[] };
    assert.ok(!searchBody.items.some((i) => i.id === conversationId), "org B must not see org A's conversation");
  });

  test("a member removed from the org is denied on a subsequent request with their stale session", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);

    const memberEmail = `removed-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Removed");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    // Sanity: works before removal.
    const before = await app.inject({
      method: "GET",
      url: "/api/conversations/search",
      headers: { cookie: member.jar.header },
    });
    assert.equal(before.statusCode, 200, `expected search to work before removal: ${before.body}`);

    void projectId;
    void agentProfileId;

    await removeMember(owner.jar, organizationId, memberEmail);

    // Same jar/cookie, unchanged — only the member row is gone now.
    const after = await app.inject({
      method: "GET",
      url: "/api/conversations/search",
      headers: { cookie: member.jar.header },
    });
    assert.equal(after.statusCode, 403, `removed member must be denied: ${after.body}`);
  });
});

describe("openhands-compat: singular conversation detail (GET /api/conversations/:id)", () => {
  test("canonical conversation_id resolves to the matching AppConversation", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { conversationId, executionId } = await createFundedAndRunningTaskWithConversation(
      owner.jar.header,
      projectId,
      agentProfileId,
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(res.statusCode, 200, `expected the detail endpoint to resolve: ${res.body}`);
    const body = JSON.parse(res.body) as { id: string; execution_status: string };
    assert.equal(body.id, conversationId);
    void executionId;
  });

  test("a legacy task id falls back to the task's latest execution", async () => {
    const suffix = randomUUID();
    const { owner, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId, conversationId } = await createFundedAndRunningTaskWithConversation(
      owner.jar.header,
      projectId,
      agentProfileId,
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${taskId}`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(res.statusCode, 200, `expected task-id fallback to resolve: ${res.body}`);
    const body = JSON.parse(res.body) as { id: string };
    assert.equal(body.id, conversationId, "task-id fallback must resolve to the same execution's conversation id");
  });

  test("a cross-org id, and a genuinely unknown id, both 404 with a null body", async () => {
    const suffixA = randomUUID();
    const suffixB = randomUUID();
    const { owner: ownerA, projectId, agentProfileId } = await setUpOwnerWithOrg(suffixA);
    const { owner: ownerB } = await setUpOwnerWithOrg(suffixB);
    const { conversationId } = await createFundedAndRunningTaskWithConversation(
      ownerA.jar.header,
      projectId,
      agentProfileId,
    );

    const crossOrgRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${conversationId}`,
      headers: { cookie: ownerB.jar.header },
    });
    assert.equal(crossOrgRes.statusCode, 404, "a conversation from another org must 404, not reveal it exists");
    assert.equal(crossOrgRes.body, "null");

    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/conversations/${randomUUID()}`,
      headers: { cookie: ownerA.jar.header },
    });
    assert.equal(unknownRes.statusCode, 404);
    assert.equal(unknownRes.body, "null");
  });
});

describe("openhands-compat: resolver behavior (resolveConversationTarget)", () => {
  test("canonical conversation_id lookup resolves with resolutionMethod: conversation_id", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { executionId, conversationId } = await createFundedAndRunningTaskWithConversation(
      owner.jar.header,
      projectId,
      agentProfileId,
    );

    const resolution = await resolveConversationTarget(conversationId, organizationId);
    assert.ok(resolution, "expected a resolution for a real conversation_id in the caller's own org");
    assert.equal(resolution!.resolutionMethod, "conversation_id");
    assert.equal(resolution!.execution?.id, executionId);
  });

  test("legacy task-id fallback resolves with resolutionMethod: task_id_fallback", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { taskId, executionId } = await createFundedAndRunningTaskWithConversation(
      owner.jar.header,
      projectId,
      agentProfileId,
    );

    const resolution = await resolveConversationTarget(taskId, organizationId);
    assert.ok(resolution, "expected a resolution when addressing by the underlying task id");
    assert.equal(resolution!.resolutionMethod, "task_id_fallback");
    assert.equal(resolution!.execution?.id, executionId, "fallback must resolve to the task's latest execution");
  });

  test("a task with zero executions yet resolves to an explicit 'not started' state, not 'not found'", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const taskId = await createFundedTask(owner.jar.header, projectId, agentProfileId);

    // Not claimed by any worker yet — zero rows in `executions` for this task.
    const resolution = await resolveConversationTarget(taskId, organizationId);
    assert.ok(resolution, "a task that exists in the caller's org, even with no executions, must resolve");
    assert.equal(resolution!.resolutionMethod, "task_id_fallback");
    assert.equal(resolution!.execution, null, "no executions yet must be an explicit null, not a thrown error");

    // The batch HTTP endpoint must reflect the same "not started" distinction
    // — a non-null AppConversation keyed on the task id, never conflated with
    // the null a genuinely-unknown/cross-org id returns.
    const batchRes = await app.inject({
      method: "GET",
      url: `/api/conversations?ids[]=${encodeURIComponent(taskId)}`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(batchRes.statusCode, 200);
    const [item] = JSON.parse(batchRes.body) as [{ id: string; execution_status: string } | null];
    assert.ok(item, "a not-yet-started task must map to a real AppConversation, not null");
    assert.equal(item!.id, taskId);
    assert.equal(item!.execution_status, "idle");

    // A genuinely unknown id, by contrast, must resolve to null.
    const unknownRes = await app.inject({
      method: "GET",
      url: `/api/conversations?ids[]=${encodeURIComponent(randomUUID())}`,
      headers: { cookie: owner.jar.header },
    });
    assert.deepEqual(JSON.parse(unknownRes.body), [null]);
  });

  test("two execution attempts for one task remain distinct (different ids, different event sets)", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const taskId = await createFundedTask(owner.jar.header, projectId, agentProfileId);

    // Attempt 1: fails, and MAX_EXECUTION_ATTEMPTS (3) means the task loops
    // back to QUEUED for a retry rather than terminally FAILED.
    const attempt1 = await claimOwnTaskExecution(taskId);
    const conv1 = `oh-conv-${randomUUID()}`;
    await reportConversation(attempt1.executionId, attempt1.workerId, conv1);
    const events1 = [messageEvent("attempt 1 message")];
    await postExecutionEvents(attempt1.executionId, attempt1.workerId, events1);
    const complete1 = await completeExecution(attempt1.executionId, attempt1.workerId, "failure");
    assert.equal(complete1.status, "QUEUED", "first failure under the attempt cap must retry, not terminate");

    // Attempt 2: succeeds.
    const attempt2 = await claimOwnTaskExecution(taskId);
    assert.notEqual(attempt2.executionId, attempt1.executionId, "a retry must be a distinct execution row");
    const conv2 = `oh-conv-${randomUUID()}`;
    await reportConversation(attempt2.executionId, attempt2.workerId, conv2);
    const events2 = [messageEvent("attempt 2 message A"), messageEvent("attempt 2 message B")];
    await postExecutionEvents(attempt2.executionId, attempt2.workerId, events2);
    const complete2 = await completeExecution(attempt2.executionId, attempt2.workerId, "success");
    assert.equal(complete2.status, "VERIFYING");

    assert.notEqual(conv1, conv2, "each execution attempt must report its own conversation id");

    const resolution1 = await resolveConversationTarget(conv1, organizationId);
    const resolution2 = await resolveConversationTarget(conv2, organizationId);
    assert.ok(resolution1 && resolution2);
    assert.notEqual(resolution1!.execution!.id, resolution2!.execution!.id);

    // The batch endpoint must return two distinct AppConversation entries,
    // each carrying only its own attempt's events.
    const batchRes = await app.inject({
      method: "GET",
      url: `/api/conversations?ids[]=${encodeURIComponent(conv1)}&ids[]=${encodeURIComponent(conv2)}`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(batchRes.statusCode, 200);
    const [item1, item2] = JSON.parse(batchRes.body) as [{ id: string } | null, { id: string } | null];
    assert.ok(item1 && item2);
    assert.notEqual(item1!.id, item2!.id);

    const eventsRes1 = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv1}/events/search`,
      headers: { cookie: owner.jar.header },
    });
    const eventsBody1 = JSON.parse(eventsRes1.body) as { items: { id: string }[] };
    assert.deepEqual(
      eventsBody1.items.map((e) => e.id).sort(),
      events1.map((e) => e.id).sort(),
    );

    const eventsRes2 = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv2}/events/search`,
      headers: { cookie: owner.jar.header },
    });
    const eventsBody2 = JSON.parse(eventsRes2.body) as { items: { id: string }[] };
    assert.deepEqual(
      eventsBody2.items.map((e) => e.id).sort(),
      events2.map((e) => e.id).sort(),
    );
  });
});

describe("openhands-compat: status/verification tag round-trip (parseAtherNullTags/serializeAtherNullTags)", () => {
  test("TaskStatus VERIFYING round-trips exactly with no verification outcome", () => {
    const tags = serializeAtherNullTags("VERIFYING", null);
    assert.deepEqual(tags, ["athernull:task-status:VERIFYING"]);
    const parsed = parseAtherNullTags(tags);
    assert.equal(parsed.taskStatus, "VERIFYING");
    assert.equal(parsed.verificationOutcome, null);
  });

  test("TaskStatus SETTLED round-trips exactly with no verification outcome", () => {
    const tags = serializeAtherNullTags("SETTLED", null);
    assert.deepEqual(tags, ["athernull:task-status:SETTLED"]);
    const parsed = parseAtherNullTags(tags);
    assert.equal(parsed.taskStatus, "SETTLED");
    assert.equal(parsed.verificationOutcome, null);
  });

  test("verification PASS round-trips exactly alongside its task status", () => {
    const tags = serializeAtherNullTags("AWAITING_ACCEPTANCE", "PASS");
    assert.deepEqual(tags, ["athernull:task-status:AWAITING_ACCEPTANCE", "athernull:verification:PASS"]);
    const parsed = parseAtherNullTags(tags);
    assert.equal(parsed.taskStatus, "AWAITING_ACCEPTANCE");
    assert.equal(parsed.verificationOutcome, "PASS");
  });

  test("verification FAIL round-trips exactly alongside its task status", () => {
    const tags = serializeAtherNullTags("FAILED", "FAIL");
    assert.deepEqual(tags, ["athernull:task-status:FAILED", "athernull:verification:FAIL"]);
    const parsed = parseAtherNullTags(tags);
    assert.equal(parsed.taskStatus, "FAILED");
    assert.equal(parsed.verificationOutcome, "FAIL");
  });

  test("a malformed/unrecognized task-status tag does not parse into valid state", () => {
    const bogus = parseAtherNullTags(["athernull:task-status:BOGUS"]);
    assert.equal(bogus.taskStatus, null, "an unrecognized TaskStatus suffix must not be accepted");
    assert.equal(bogus.verificationOutcome, null);

    const unrelated = parseAtherNullTags(["some:unrelated:tag", "openhands:native:chip"]);
    assert.equal(unrelated.taskStatus, null);
    assert.equal(unrelated.verificationOutcome, null);

    // A bogus tag alongside a valid one must not clobber the valid value —
    // parsing is per-tag, not all-or-nothing.
    const mixed = parseAtherNullTags(["athernull:task-status:VERIFYING", "athernull:task-status:BOGUS"]);
    assert.equal(mixed.taskStatus, "VERIFYING", "a later bogus tag must not overwrite an already-parsed valid one");

    // A bogus verification suffix must be rejected the same way.
    const bogusVerification = parseAtherNullTags(["athernull:verification:MAYBE"]);
    assert.equal(bogusVerification.verificationOutcome, null);
  });
});

describe("openhands-compat: static source-level safety assertions", () => {
  // Strips `//` and `/* */` comments so the header/design commentary that
  // legitimately *names* SESSION_API_KEY and /internal/* (to document that
  // they must never be used) doesn't trip a naive substring search — this
  // checks the actual executable source, not prose about it.
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

  const routeFilePath = fileURLToPath(new URL("../src/routes/openhands-compat.ts", import.meta.url));
  const routeSource = readFileSync(routeFilePath, "utf8");
  const codeOnly = stripComments(routeSource);

  test("no route in openhands-compat.ts reads SESSION_API_KEY outside of comments", () => {
    assert.ok(
      routeSource.includes("SESSION_API_KEY"),
      "sanity check: the file's documentation comment should still mention SESSION_API_KEY",
    );
    assert.ok(
      !codeOnly.includes("SESSION_API_KEY"),
      "SESSION_API_KEY must never appear in this file's actual code, only in comments explaining why not",
    );
  });

  test("no route in openhands-compat.ts calls anything under /internal/*", () => {
    assert.ok(
      routeSource.includes("/internal/"),
      "sanity check: the file's documentation comment should still mention /internal/*",
    );
    assert.ok(
      !codeOnly.includes("/internal/"),
      "/internal/* must never appear in this file's actual code, only in comments explaining why not",
    );
  });
});
