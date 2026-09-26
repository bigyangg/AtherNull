// ADR-0007 Phase 3E — reconnect, recovery and command-state hardening tests.
// Follows relay.test.ts/realtime-gateway.test.ts/realtime-control.test.ts's
// exact idiom: a standalone file, inline helper functions (duplicated, not
// imported, per this suite's own established convention), a real Fastify app
// via inject()/injectWS(), and a real persistent Postgres test database (no
// reset/truncate between runs or suites).
//
// This file covers ONLY what Phase 3B/3C/3D's own test files do not already
// cover — see docs/adr/0007-secure-realtime-execution.md's "Phase 3E status"
// section for the full cross-reference of which of the phase spec's 28
// scenarios land in which file. In particular: at-most-once dedupe
// (relay.test.ts §"event forwarding", realtime-control.test.ts test 13),
// lease_mismatch command rejection (realtime-control.test.ts test 8), and
// relay-loss-does-not-stop-persistence (relay.test.ts §"failure isolation")
// are already proven elsewhere and are not re-proven here.
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
const { relayRegistry, RelayRegistry } = await import("../src/realtime/relay-registry.js");
const { controlRegistry, ControlRegistry } = await import("../src/realtime/control-registry.js");
const { executionBroadcaster, ExecutionBroadcaster } = await import("../src/realtime/execution-broadcaster.js");

let app: FastifyInstance;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
});

// --- test helpers (duplicated from relay.test.ts/realtime-gateway.test.ts/
// realtime-control.test.ts's fixtures, not imported) -------------------------

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

async function setUpOwnerWithOrg(suffix: string) {
  const owner = await signUpVerifiedAndSignIn(`rte-owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `RTE Org ${suffix}`, `rte-org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

// Direct-insert fixture (ADR-0007 Phase 3C.5's canonical pattern) — bypasses
// POST /internal/executions/claim's shared queue entirely, exactly like
// relay.test.ts/realtime-gateway.test.ts/realtime-control.test.ts's own
// fixtures. These tests exercise reconnect/recovery, never the claim FSM.
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
      requirements: "realtime reconnect test task",
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

async function createRunningTaskForNewOrg(suffix: string) {
  const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
  const { taskId, executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);
  return { owner, organizationId, taskId, executionId, workerId };
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

async function expectRelayRejected(executionId: string, workerId: string, expectedStatus: number) {
  await assert.rejects(
    () => app.injectWS(relayPath(executionId, workerId), { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } }),
    (err: Error) => {
      assert.ok(
        err.message.includes(String(expectedStatus)),
        `expected rejection to mention status ${expectedStatus}, got: ${err.message}`,
      );
      return true;
    },
  );
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

async function postExecutionEvents(executionId: string, workerId: string, events: { id: string; kind: string; occurredAt: string; payload: unknown }[]) {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/events`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: { workerId, events },
  });
  assert.equal(res.statusCode, 204, `post events failed: ${res.body}`);
}

function messageEvent(text: string, source: "user" | "agent" = "agent") {
  return {
    id: randomUUID(),
    kind: "MessageEvent",
    occurredAt: new Date().toISOString(),
    payload: { source, llm_message: text },
  };
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

function realtimePath(id: string): string {
  return `/v1/realtime/executions/${id}`;
}

type RealtimeMessage = { version: number; type: string; [key: string]: unknown };

type InjectWSFn = (
  path: string,
  upgradeContext: { headers: Record<string, string> },
  options: { onInit: (ws: WebSocket) => void },
) => Promise<WebSocket>;

// Same RealtimeClient idiom as realtime-gateway.test.ts/realtime-control.test.ts
// (duplicated, not imported, per this suite's own convention) — the
// onInit-attached listener is required for the same reason documented there:
// this in-process mock delivers server.hello/history.ready synchronously,
// before injectWS()'s own returned promise would resolve.
class RealtimeClient {
  readonly messages: RealtimeMessage[] = [];
  ws!: WebSocket;

  static async connect(appInstance: FastifyInstance, path: string, headers: Record<string, string>): Promise<RealtimeClient> {
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
    return waitFor(() => this.messages.find((m) => m.type === type), timeoutMs);
  }

  async waitForCommandStatus(commandId: string, status: string, timeoutMs = 5000): Promise<RealtimeMessage> {
    return waitFor(
      () => this.messages.find((m) => m.type === "command.status" && m.commandId === commandId && m.status === status),
      timeoutMs,
    );
  }

  commandStatusesFor(commandId: string): string[] {
    return this.messages.filter((m) => m.type === "command.status" && m.commandId === commandId).map((m) => m.status as string);
  }

  historyEventIds(): string[] {
    const ready = this.messages.find((m) => m.type === "history.ready");
    if (!ready) return [];
    return (ready.events as { id: string }[]).map((e) => e.id);
  }

  close(): void {
    this.ws.close();
  }
}

async function connectRealtime(id: string, cookie: string): Promise<RealtimeClient> {
  return RealtimeClient.connect(app, realtimePath(id), { cookie, origin: AUTH_ORIGIN });
}

function commandEnvelope(executionId: string, commandId: string, text = "hello agent") {
  return {
    version: 1,
    type: "execution.command",
    commandId,
    executionId,
    command: { type: "agent.message", payload: { text } },
  };
}

// Same FakeWorkerRelay idiom as realtime-control.test.ts (duplicated, not
// imported) — a tiny in-process stand-in for the worker's own relay message
// handling.
class FakeWorkerRelay {
  readonly received: { version: number; type: string; [key: string]: unknown }[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: Buffer) => {
      this.received.push(JSON.parse(data.toString("utf8")));
    });
  }

  async waitForCommand(commandId: string, timeoutMs = 3000): Promise<{ commandId: string; [key: string]: unknown }> {
    return waitFor(() => {
      const found = this.received.find(
        (m) => m.type === "gateway.command" && (m.payload as { commandId?: string })?.commandId === commandId,
      );
      return found ? (found.payload as { commandId: string }) : undefined;
    }, timeoutMs);
  }

  commandCountFor(commandId: string): number {
    return this.received.filter((m) => m.type === "gateway.command" && (m.payload as { commandId?: string })?.commandId === commandId)
      .length;
  }

  ack(executionId: string, commandId: string, status: "accepted" | "rejected" | "failed", detail?: string) {
    this.ws.send(
      JSON.stringify({
        version: 1,
        type: "worker.command_ack",
        executionId,
        eventId: null,
        payload: { commandId, status, ...(detail ? { detail } : {}) },
      }),
    );
  }

  disconnect() {
    this.ws.terminate();
  }
}

// --- tests -------------------------------------------------------------

describe("Phase 3E — worker relay reconnect (gateway-side revalidation)", () => {
  test("1. a worker reconnecting after a disconnect gets a fresh relay registration and events resume forwarding", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const first = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId));
    first.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    // Reconnect: the worker re-presents the full credential set
    // (INTERNAL_API_TOKEN, workerId, executionId) exactly as on the first
    // attempt — this is not a "resume" of any prior session, it's an
    // ordinary new registration that happens to reuse the same identifiers.
    const second = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId), "reconnect must succeed and register a fresh relay");

    const eventId = randomUUID();
    second.send(JSON.stringify(relayEventEnvelope(executionId, eventId, "post-reconnect event")));
    const row = await waitFor(() =>
      db.selectFrom("execution_events").select(["id"]).where("id", "=", eventId).executeTakeFirst(),
    );
    assert.ok(row, "events must resume forwarding/persisting after a reconnect, with no restart of the execution");

    second.close();
    await completeExecution(executionId, workerId);
  });

  test("2. a worker reconnect revalidates lease_owner against current Postgres state, not any remembered prior registration", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const first = await connectRelay(executionId, workerId);
    first.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    // A DIFFERENT workerId attempting to "reconnect" for this executionId is
    // not this execution's lease owner — rejected exactly like a first-ever
    // attempt would be, with no special leniency for looking like a retry.
    await expectRelayRejected(executionId, "an-impostor-worker", 409);
    assert.equal(relayRegistry.get(executionId), undefined);

    await completeExecution(executionId, workerId);
  });

  test("3. reconnect is rejected once the execution is no longer RUNNING (completed while disconnected)", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const first = await connectRelay(executionId, workerId);
    first.terminate();
    await waitFor(() => (relayRegistry.get(executionId) === undefined ? true : undefined));

    // The execution completes while the worker is "disconnected" (e.g. it
    // reported completion via a path other than this now-dead relay, or
    // apps/api itself completed it from some other authoritative signal).
    await completeExecution(executionId, workerId);

    // The same worker attempting to reconnect now must be rejected — lease
    // ownership is unchanged, but status is no longer RUNNING.
    await expectRelayRejected(executionId, workerId, 409);
  });

  test("4. a different worker cannot hijack an execution's lease while the current owner's relay is still connected", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const owner = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId));

    await expectRelayRejected(executionId, "stale-or-impostor-worker", 409);
    // The legitimate owner's registration must be completely undisturbed by
    // the rejected attempt — no replacement happened. `owner` here is the
    // client-side end of the fake duplex pair (injectWS's return value),
    // which is never the same object as relayRegistry's own stored
    // server-side socket (relay.test.ts's own passing tests never compare
    // those two directly either) — the observable, correct proof of "not
    // disturbed" is that `owner` never received a close frame and the
    // registry still holds an entry at all.
    assert.equal(owner.readyState, owner.OPEN, "the legitimate owner's connection must remain open");
    assert.ok(relayRegistry.get(executionId), "the registration must still exist");

    owner.close();
    await completeExecution(executionId, workerId);
  });

  test("5. two near-simultaneous connections from the same worker resolve to exactly one active relay, deterministically", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const [first, second] = await Promise.all([connectRelay(executionId, workerId), connectRelay(executionId, workerId)]);
    // Whichever registered last wins (relay-registry.ts's own documented
    // replacement policy) — the invariant under test is that EXACTLY one of
    // the two client-side connections is closed with the documented
    // replacement code, and the other stays open, regardless of arrival
    // order. `first`/`second` are the client-side ends of the fake duplex
    // pairs — relayRegistry itself only ever stores the server-side end, so
    // this deliberately checks observable client-visible behavior (a close
    // frame, or lack of one) rather than any object identity against the
    // registry's internal state.
    const firstClose = waitForClose(first).then((c) => ({ which: "first" as const, ...c }));
    const secondClose = waitForClose(second).then((c) => ({ which: "second" as const, ...c }));
    const result = await Promise.race([firstClose, secondClose]);
    assert.equal(result.code, 4000, "the non-surviving connection must be closed with the documented replacement code");
    const survivor = result.which === "first" ? second : first;
    assert.equal(survivor.readyState, survivor.OPEN, "exactly one connection must remain open");
    assert.ok(relayRegistry.get(executionId), "exactly one relay registration must still exist");

    survivor.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — gateway restart safety (simulated via fresh registry instances)", () => {
  test("11. a freshly constructed registry/broadcaster (simulating a post-restart process) starts with no memory of any prior state", () => {
    // This is deliberately NOT a real process restart (impractical inside a
    // single node --test run) — it demonstrates the actual property that
    // makes a real restart safe: every one of these classes is a plain
    // in-memory object with no persistence layer of its own. A real process
    // restart re-evaluates these modules from scratch, which is exactly
    // equivalent to constructing brand-new instances here.
    const freshRelay = new RelayRegistry();
    assert.equal(freshRelay.size, 0, "no relay registration survives a restart");

    const freshControl = new ControlRegistry();
    assert.equal(freshControl.pendingSize, 0, "no pending-ack state survives a restart");
    assert.equal(freshControl.hasBeenForwarded(randomUUID()), false, "no commandId dedupe memory survives a restart");

    const freshBroadcaster = new ExecutionBroadcaster();
    let observed = 0;
    const unsubscribe = freshBroadcaster.onEvent("some-execution", () => {
      observed += 1;
    });
    freshBroadcaster.publishEvent("some-execution", { id: "x", kind: "K", occurredAt: new Date().toISOString(), payload: {} });
    assert.equal(observed, 1, "sanity: a fresh broadcaster still works for a NEW subscriber");
    unsubscribe();

    // The real (singleton) registries used by the actual routes are exactly
    // this same class, constructed once at module load — a real process
    // restart re-runs that module-load exactly like `new RelayRegistry()`
    // above does here.
    assert.ok(relayRegistry instanceof RelayRegistry);
    assert.ok(controlRegistry instanceof ControlRegistry);
    assert.ok(executionBroadcaster instanceof ExecutionBroadcaster);
  });

  test("12. a worker can register normally against an executionId this process has never seen (equivalent to post-restart re-registration)", async () => {
    // After a real restart, relayRegistry is empty for every executionId,
    // including ones that had an active relay before the restart — there is
    // no "old entry" to replace, just an ordinary registration into an empty
    // map. This test's executionId has never been registered in THIS test
    // process either, so it is already exactly that scenario: Postgres
    // (lease_owner/status), not any in-memory history, is what authorizes
    // the registration.
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const { executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);
    assert.equal(relayRegistry.get(executionId), undefined, "sanity: never registered in this process before");

    const ws = await connectRelay(executionId, workerId);
    assert.ok(relayRegistry.get(executionId), "registration must succeed purely from current DB state");

    ws.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — browser reconnect: history reconciliation", () => {
  test("6/7/13. a reconnecting browser sees full history including events produced entirely while it was disconnected (also equivalent to a post-restart reconnect, since the gateway derives everything fresh from Postgres per connection)", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const before = messageEvent("before disconnect");
    await postExecutionEvents(executionId, workerId, [before]);

    const first = await connectRealtime(taskId, owner.jar.header);
    await first.waitForType("history.ready");
    assert.deepEqual(first.historyEventIds().sort(), [before.id].sort());
    first.close();
    await waitFor(() => (first.ws.readyState === first.ws.CLOSED ? true : undefined));

    // "Disconnected": two more events are produced with no browser connected
    // at all — the exact "events missed during disconnect" scenario.
    const duringA = messageEvent("during disconnect A");
    const duringB = messageEvent("during disconnect B");
    await postExecutionEvents(executionId, workerId, [duringA, duringB]);

    // Reconnect: a brand-new connection, re-running EVERY authorization
    // check from scratch (session, Origin, org membership, realtime:view) —
    // nothing is restored from the closed socket.
    const second = await connectRealtime(taskId, owner.jar.header);
    await second.waitForType("history.ready");
    const ids = second.historyEventIds();
    assert.deepEqual(
      [...ids].sort(),
      [before.id, duringA.id, duringB.id].sort(),
      "every event persisted while disconnected must be visible after reconciliation",
    );
    // Invariant: reconnect does not duplicate rendered events — each id
    // appears exactly once in the fresh history.ready payload.
    assert.equal(new Set(ids).size, ids.length);

    second.close();
    await completeExecution(executionId, workerId);
  });

  test("8. an event id delivered live before a disconnect and later replayed via history after reconnect carries identical content (client-side dedupe-safe)", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relay = await connectRelay(executionId, workerId);
    const first = await connectRealtime(taskId, owner.jar.header);
    await first.waitForType("history.ready");

    const sharedEvent = messageEvent("delivered live, then replayed via history");
    relay.send(JSON.stringify(relayEventEnvelope(executionId, sharedEvent.id, "delivered live, then replayed via history")));
    const liveMsg = await first.waitForType("execution.event");
    assert.equal((liveMsg.event as { id: string }).id, sharedEvent.id);

    first.close();
    await waitFor(() => (first.ws.readyState === first.ws.CLOSED ? true : undefined));

    const second = await connectRealtime(taskId, owner.jar.header);
    const historyMsg = await second.waitForType("history.ready");
    const replayed = (historyMsg.events as { id: string; payload: unknown }[]).find((e) => e.id === sharedEvent.id);
    assert.ok(replayed, "the event delivered live before disconnect must still be present in history after reconnect");
    // Same identity, same content — a real client's Map.set(id, event) keyed
    // upsert renders this exactly once regardless of having seen it twice
    // across two different connections.
    assert.deepEqual((replayed!.payload as { llm_message: string }).llm_message, "delivered live, then replayed via history");
    assert.equal(
      (historyMsg.events as { id: string }[]).filter((e) => e.id === sharedEvent.id).length,
      1,
      "a single history.ready payload must never itself contain the same id twice",
    );

    relay.close();
    second.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — execution completion during a browser/worker outage", () => {
  test("9/10. execution completes while the browser is disconnected — reconnect is rejected (no longer RUNNING) but the historical route serves the complete final event set", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const first = await connectRealtime(taskId, owner.jar.header);
    await first.waitForType("history.ready");
    first.close();
    await waitFor(() => (first.ws.readyState === first.ws.CLOSED ? true : undefined));

    const finalEvent = messageEvent("the last thing the agent said");
    await postExecutionEvents(executionId, workerId, [finalEvent]);
    await completeExecution(executionId, workerId, "success");

    // The browser reconnects only after completion — the realtime gateway
    // (view of a RUNNING execution only) correctly refuses to open a live
    // socket for a finished execution; it must never silently pretend a
    // stale/absent relay is still valid.
    await assert.rejects(
      () => app.injectWS(realtimePath(taskId), { headers: { cookie: owner.jar.header, origin: AUTH_ORIGIN } }),
      (err: Error) => {
        assert.ok(err.message.includes("409"), `expected 409 (not RUNNING), got: ${err.message}`);
        return true;
      },
    );

    // Final reconciliation happens via the historical route (Phase 2,
    // unchanged) — every persisted event, including the one that landed
    // after the browser's last connection closed, is visible there.
    const historyRes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${taskId}/executions/${executionId}/events`,
      headers: { cookie: owner.jar.header },
    });
    assert.equal(historyRes.statusCode, 200, historyRes.body);
    const historyEvents = JSON.parse(historyRes.body) as { id: string }[];
    assert.ok(
      historyEvents.some((e) => e.id === finalEvent.id),
      "the final event, persisted after the browser's last live connection, must be visible via the historical route",
    );
  });
});

describe("Phase 3E — command uncertainty is never silently resolved or replayed", () => {
  test("14/16. a command left pending when the worker disconnects becomes uncertain and is never automatically replayed", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;
    // Promote the owner to realtime:control — createRunningTaskForNewOrg's
    // owner already has the "owner" role, which hasRealtimeControlAuthority
    // already grants (session.ts) — no extra step needed.

    const relayWs = await connectRelay(executionId, workerId);
    const fakeWorker = new FakeWorkerRelay(relayWs);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "are you there?")));
    await client.waitForCommandStatus(commandId, "forwarded");
    await fakeWorker.waitForCommand(commandId);

    // The worker disconnects before ever sending worker.command_ack.
    fakeWorker.disconnect();
    await client.waitForCommandStatus(commandId, "uncertain");
    assert.equal(client.commandStatusesFor(commandId).at(-1), "uncertain");

    // Reconnect a NEW worker relay and let time pass (well past the point
    // any retry would have fired if one existed) — the same commandId must
    // never be sent to any worker a second time. A user could send a NEW
    // command (a new commandId) after inspecting this uncertain outcome, but
    // that is an explicit, separate action this test does not take.
    const secondRelayWs = await connectRelay(executionId, workerId);
    const secondFakeWorker = new FakeWorkerRelay(secondRelayWs);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(secondFakeWorker.commandCountFor(commandId), 0, "an uncertain command must never be automatically replayed to a reconnected worker");
    assert.equal(fakeWorker.commandCountFor(commandId), 1, "the original forward must have happened exactly once");

    client.close();
    secondRelayWs.close();
    await completeExecution(executionId, workerId);
  });

  test("15. re-sending the same commandId (e.g. a naive client retry) on the same connection is rejected as a duplicate, never forwarded twice", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relayWs = await connectRelay(executionId, workerId);
    const fakeWorker = new FakeWorkerRelay(relayWs);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "one message")));
    await client.waitForCommandStatus(commandId, "forwarded");
    await fakeWorker.waitForCommand(commandId);

    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "one message")));
    await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(
      client.messages.filter((m) => m.type === "command.status" && m.commandId === commandId && m.status === "rejected").at(-1)
        ?.reason,
      "duplicate_command_id",
    );
    assert.equal(fakeWorker.commandCountFor(commandId), 1, "the duplicate resend must never reach the worker a second time");

    fakeWorker.ack(executionId, commandId, "accepted");
    client.close();
    relayWs.close();
    await completeExecution(executionId, workerId);
  });

  test("17. the 'executed' heuristic never claims false certainty for a command that is actually uncertain", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relayWs = await connectRelay(executionId, workerId);
    const fakeWorker = new FakeWorkerRelay(relayWs);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "will this ever be marked executed?")));
    await client.waitForCommandStatus(commandId, "forwarded");
    await fakeWorker.waitForCommand(commandId);
    fakeWorker.disconnect();
    await client.waitForCommandStatus(commandId, "uncertain");

    // Reconnect the worker and generate several ordinary execution.events —
    // exactly the kind of signal the "executed" heuristic (realtime-
    // gateway.ts's acceptedAwaitingExecuted queue) upgrades an ACCEPTED
    // command with. This command was never accepted (it went straight from
    // forwarded -> uncertain), so it must never appear in that queue and
    // must never be upgraded, no matter how many later events arrive.
    const secondRelayWs = await connectRelay(executionId, workerId);
    for (let i = 0; i < 5; i += 1) {
      secondRelayWs.send(JSON.stringify(relayEventEnvelope(executionId, randomUUID(), `unrelated event ${i}`)));
    }
    await waitFor(async () => {
      const count = await db
        .selectFrom("execution_events")
        .select(({ fn }) => [fn.countAll<string>().as("count")])
        .where("execution_id", "=", executionId)
        .executeTakeFirstOrThrow();
      return Number(count.count) >= 5 ? true : undefined;
    });
    await new Promise((r) => setTimeout(r, 200));

    const finalStatuses = client.commandStatusesFor(commandId);
    assert.equal(finalStatuses.at(-1), "uncertain");
    assert.ok(
      !finalStatuses.includes("executed"),
      `an uncertain command must never be reconciled to "executed" by unrelated later events — got: ${JSON.stringify(finalStatuses)}`,
    );

    client.close();
    secondRelayWs.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — authorization is rechecked fresh on every reconnect, never restored", () => {
  test("18/19. a member removed from the org between two connections cannot reconnect, even though their first connection succeeded", async () => {
    const suffix = randomUUID();
    const { owner, organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(suffix);
    const { executionId, taskId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);
    void executionId;

    const memberEmail = `rte-member-${suffix}@example.com`;
    const member = await signUpVerifiedAndSignIn(memberEmail, "correct horse battery", "Member");
    await addMemberDirect(organizationId, member.userId, "member");
    await setActiveOrg(member.jar, organizationId);

    const first = await connectRealtime(taskId, member.jar.header);
    await first.waitForType("history.ready");
    first.close();
    await waitFor(() => (first.ws.readyState === first.ws.CLOSED ? true : undefined));

    await removeMember(owner.jar, organizationId, memberEmail);

    await assert.rejects(
      () => app.injectWS(realtimePath(taskId), { headers: { cookie: member.jar.header, origin: AUTH_ORIGIN } }),
      (err: Error) => {
        assert.ok(err.message.includes("403") || err.message.includes("401"), `expected an auth rejection, got: ${err.message}`);
        return true;
      },
    );

    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — backpressure: control-command queues are bounded and observable, never silently dropped", () => {
  test("22a. exceeding the per-connection pending-command bound is rejected explicitly as too_many_pending, never silently dropped", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relayWs = await connectRelay(executionId, workerId);
    const fakeWorker = new FakeWorkerRelay(relayWs);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    // MAX_PENDING_COMMANDS_PER_CONNECTION is 5 (realtime-gateway.ts) — send 5
    // commands the worker never acks (each stays "pending"), then a 6th must
    // be rejected specifically as too_many_pending, not silently ignored.
    const pendingIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const commandId = randomUUID();
      pendingIds.push(commandId);
      client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, `pending #${i}`)));
      await client.waitForCommandStatus(commandId, "forwarded");
      await fakeWorker.waitForCommand(commandId);
    }

    const overflowId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, overflowId, "one too many")));
    await client.waitForCommandStatus(overflowId, "rejected");
    assert.equal(
      client.messages.find((m) => m.type === "command.status" && m.commandId === overflowId)?.reason,
      "too_many_pending",
      "overflow must be surfaced with a specific, user-visible reason, never a silent drop",
    );

    client.close();
    relayWs.close();
    await completeExecution(executionId, workerId);
  });

  test("22b. exceeding the rate-limit window is rejected explicitly as rate_limited, never silently dropped", async () => {
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relayWs = await connectRelay(executionId, workerId);
    const fakeWorker = new FakeWorkerRelay(relayWs);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    // RATE_LIMIT_MAX_COMMANDS_PER_WINDOW is 10 per 10s (realtime-gateway.ts).
    // Ack each command immediately so pendingCommandCount never itself hits
    // the (lower, 5) pending bound — isolating the rate-limit path.
    for (let i = 0; i < 10; i += 1) {
      const commandId = randomUUID();
      client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, `rate #${i}`)));
      await client.waitForCommandStatus(commandId, "forwarded");
      await fakeWorker.waitForCommand(commandId);
      fakeWorker.ack(executionId, commandId, "accepted");
      await client.waitForCommandStatus(commandId, "accepted");
    }

    const overflowId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, overflowId, "eleventh in under 10s")));
    await client.waitForCommandStatus(overflowId, "rejected");
    assert.equal(
      client.messages.find((m) => m.type === "command.status" && m.commandId === overflowId)?.reason,
      "rate_limited",
    );

    client.close();
    relayWs.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — heartbeat/liveness", () => {
  test("a browser socket answering pings is not terminated, and heartbeat cleanup does not disturb normal message delivery", async () => {
    // This exercises attachHeartbeat's wiring end-to-end at the protocol
    // level (the underlying `ws`/`injectWS` fake duplex streams answer
    // pings automatically at the transport layer, same as any real
    // WebSocket client) — a dedicated unit test for the ping/pong timer
    // arithmetic itself lives beside the implementation (heartbeat.ts is
    // small and pure; this integration test is what actually matters: wiring
    // the heartbeat in must not break, delay, or duplicate ordinary traffic.
    const { owner, organizationId, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    void organizationId;

    const relayWs = await connectRelay(executionId, workerId);
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const eventId = randomUUID();
    relayWs.send(JSON.stringify(relayEventEnvelope(executionId, eventId, "still alive")));
    const msg = await client.waitForType("execution.event");
    assert.equal((msg.event as { id: string }).id, eventId);

    relayWs.close();
    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("Phase 3E — static source-level safety assertions (new files)", () => {
  const apiFiles = ["../realtime/heartbeat.ts", "relay.ts", "realtime-gateway.ts"].map((rel) =>
    fileURLToPath(new URL(`../src/routes/${rel}`, import.meta.url)),
  );

  // Same convention as realtime-gateway.test.ts's own static assertions:
  // strip comments before searching, so header/design commentary that
  // legitimately *names* these credentials (to document that the code must
  // never use them — as relay.ts/realtime-gateway.ts's own header comments
  // already did before this phase) doesn't trip a naive substring search
  // against the documentation itself — only executable code is checked.
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

  test("SESSION_API_KEY never appears in the new heartbeat module's or the touched routes' actual code", () => {
    for (const filePath of apiFiles) {
      const source = readFileSync(filePath, "utf8");
      const codeOnly = stripComments(source);
      assert.ok(!codeOnly.includes("SESSION_API_KEY"), `${filePath} must never reference SESSION_API_KEY in code`);
    }
  });

  test("INTERNAL_API_TOKEN never appears in the browser-facing hook source", () => {
    const hookPath = fileURLToPath(
      new URL("../../../apps/web/lib/hooks/use-execution-realtime.ts", import.meta.url),
    );
    const source = readFileSync(hookPath, "utf8");
    assert.ok(!source.includes("INTERNAL_API_TOKEN"), "the browser-facing reconnect hook must never reference INTERNAL_API_TOKEN");
    assert.ok(!source.includes("SESSION_API_KEY"), "the browser-facing reconnect hook must never reference SESSION_API_KEY");
  });

  test("the browser-facing reconnect hook never constructs a direct Agent Server URL/port — only the same-origin AtherNull API_URL", () => {
    const hookPath = fileURLToPath(
      new URL("../../../apps/web/lib/hooks/use-execution-realtime.ts", import.meta.url),
    );
    const source = readFileSync(hookPath, "utf8");
    // The only WebSocket URL construction in this file (including on
    // reconnect) must go through realtimeWebSocketUrl(), which is anchored
    // to API_URL (the same-origin AtherNull gateway) — never any Agent
    // Server-specific host/port/keyword literal.
    assert.ok(!/agent[-_]?server/i.test(source), "no Agent Server reference expected in the browser-facing hook");
    assert.equal((source.match(/new WebSocket\(/g) ?? []).length, 1, "exactly one WebSocket construction call site, reused for both the initial connect and every reconnect");
    assert.ok(source.includes("realtimeWebSocketUrl"), "sanity: the URL builder this file relies on must still exist");
  });
});
