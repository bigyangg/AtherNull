// ADR-0007 Phase 3D — authorized browser -> agent control tests. Follows
// realtime-gateway.test.ts/relay.test.ts's exact idiom: a standalone file,
// inline helper functions (duplicated, not imported), a real Fastify app via
// inject()/injectWS(), and a real persistent Postgres test database (no
// reset/truncate between runs or suites). See job-lifecycle.test.ts's header
// comment for the shared-claim-queue race this suite must not reintroduce —
// every fixture here uses createRunningExecutionDirect-style direct-insert
// setup, never the real claim endpoint.
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

// --- test helpers (duplicated from realtime-gateway.test.ts's fixtures, not
// imported, per this suite's own established convention) -------------------

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
  const owner = await signUpVerifiedAndSignIn(`rtc-owner-${suffix}@example.com`, "correct horse battery", "Owner");
  const organizationId = await createOrgAsOwner(owner.jar, `RTC Org ${suffix}`, `rtc-org-${suffix}`);
  const { projectId, agentProfileId } = await seedProjectAndAgentProfile(organizationId, owner.userId);
  return { owner, organizationId, projectId, agentProfileId };
}

async function addPlainMember(organizationId: string, suffix: string) {
  const member = await signUpVerifiedAndSignIn(`rtc-member-${suffix}@example.com`, "correct horse battery", "Member");
  await addMemberDirect(organizationId, member.userId, "member");
  await setActiveOrg(member.jar, organizationId);
  return member;
}

// See job-lifecycle.test.ts/relay.test.ts/realtime-gateway.test.ts's headers
// for why this bypasses POST /internal/executions/claim entirely.
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
      requirements: "realtime control test task",
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
  return { owner, organizationId, projectId, agentProfileId, taskId, executionId, workerId };
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

async function postExecutionEvents(executionId: string, workerId: string, text = "hello") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/executions/${executionId}/events`,
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    payload: {
      workerId,
      events: [
        {
          id: randomUUID(),
          kind: "MessageEvent",
          occurredAt: new Date().toISOString(),
          payload: { source: "agent", llm_message: text },
        },
      ],
    },
  });
  assert.equal(res.statusCode, 204, `post events failed: ${res.body}`);
}

function relayPath(executionId: string, workerId: string): string {
  return `/internal/relay/${executionId}?workerId=${encodeURIComponent(workerId)}`;
}

async function connectRelay(executionId: string, workerId: string): Promise<WebSocket> {
  return app.injectWS(relayPath(executionId, workerId), { headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });
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
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`waitForType(${type}): timed out. Received so far: ${JSON.stringify(this.messages)}`);
  }

  async waitForCommandStatus(commandId: string, status: string, timeoutMs = 5000): Promise<RealtimeMessage> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.messages.find((m) => m.type === "command.status" && m.commandId === commandId && m.status === status);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(
      `waitForCommandStatus(${commandId}, ${status}): timed out. Received so far: ${JSON.stringify(this.messages)}`,
    );
  }

  commandStatusesFor(commandId: string): string[] {
    return this.messages.filter((m) => m.type === "command.status" && m.commandId === commandId).map((m) => m.status as string);
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

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== undefined) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor: timed out");
}

// A tiny in-process stand-in for the worker's own relay message handling —
// collects gateway.command envelopes it receives and lets a test send back a
// worker.command_ack on demand, exactly like relay_client.py's real receive
// loop would.
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

describe("realtime:control authorization", () => {
  test("1. a member without realtime:control cannot submit a command (proper execution.command envelope)", async () => {
    const { organizationId, projectId, agentProfileId } = await setUpOwnerWithOrg(randomUUID());
    const member = await addPlainMember(organizationId, randomUUID());
    const { taskId, executionId, workerId } = await createRunningExecutionDirect(organizationId, projectId, agentProfileId);

    const client = await connectRealtime(taskId, member.jar.header);
    const hello = await client.waitForType("server.hello");
    assert.equal(hello.canControl, false, "a plain member must not be reported as holding realtime:control");

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    const error = await client.waitForType("error");
    assert.equal(error.code, "control_not_supported");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("2. an owner (realtime:control) can submit an allowed agent.message command, which reaches the worker relay", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    const hello = await client.waitForType("server.hello");
    assert.equal(hello.canControl, true, "an owner must be reported as holding realtime:control");

    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "hello from an authorized owner")));

    await client.waitForCommandStatus(commandId, "received");
    await client.waitForCommandStatus(commandId, "authorized");
    await client.waitForCommandStatus(commandId, "forwarded");

    const forwarded = await relay.waitForCommand(commandId);
    assert.equal((forwarded.command as { type: string }).type, "agent.message");
    assert.equal(((forwarded.command as { payload: { text: string } }).payload).text, "hello from an authorized owner");

    relay.ack(executionId, commandId, "accepted");
    await client.waitForCommandStatus(commandId, "accepted");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("3. an unauthenticated connection cannot control (rejected at connect time, same as view)", async () => {
    const { taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    await assert.rejects(() => app.injectWS(realtimePath(taskId), { headers: { origin: AUTH_ORIGIN } }), (err: Error) => {
      assert.ok(err.message.includes("401"));
      return true;
    });
    await completeExecution(executionId, workerId);
  });

  test("4. a member of a different organization cannot control (rejected at connect time, non-distinguishing 404)", async () => {
    const { taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const { owner: otherOwner } = await setUpOwnerWithOrg(randomUUID());
    await assert.rejects(
      () => app.injectWS(realtimePath(taskId), { headers: { cookie: otherOwner.jar.header, origin: AUTH_ORIGIN } }),
      (err: Error) => {
        assert.ok(err.message.includes("404"));
        return true;
      },
    );
    await completeExecution(executionId, workerId);
  });

  test("5. a wrong Origin cannot control (rejected at connect time)", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    await assert.rejects(
      () => app.injectWS(realtimePath(taskId), { headers: { cookie: owner.jar.header, origin: "http://evil.example.com" } }),
      (err: Error) => {
        assert.ok(err.message.includes("403"));
        return true;
      },
    );
    await completeExecution(executionId, workerId);
  });
});

describe("realtime:control per-command server-side revalidation", () => {
  test("6. a command sent after the execution stops being RUNNING is rejected, without disturbing the live view", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    // Flip status directly (NOT via /internal/.../complete, which would also
    // close the socket via relayRegistry/broadcaster) to isolate the
    // per-command RUNNING revalidation from the server-driven-completion
    // behavior already covered by realtime-gateway.test.ts.
    await db.updateTable("executions").set({ status: "LEASE_EXPIRED" }).where("id", "=", executionId).execute();

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "execution_not_running");

    // The read-only stream must still be alive and unaffected (1 === ws.OPEN).
    assert.equal(client.ws.readyState, 1);

    client.close();
    // Restore RUNNING so completeExecution's own status checks pass cleanly.
    await db.updateTable("executions").set({ status: "RUNNING" }).where("id", "=", executionId).execute();
    await completeExecution(executionId, workerId);
  });

  test("7. a command with no active worker relay is rejected as no_active_relay", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "no_active_relay");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("8. a lease_owner mismatch between the executions row and the registered relay is rejected as lease_mismatch", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const relaySocket = await connectRelay(executionId, workerId);
    // Simulate the lease having moved on (a real reclaim would also close
    // the relay via relayRegistry.closeAndRemove — this test isolates the
    // defense-in-depth lease check itself from that separate mechanism).
    await db.updateTable("executions").set({ lease_owner: "some-other-worker" }).where("id", "=", executionId).execute();

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "lease_mismatch");

    relaySocket.close();
    client.close();
    await db.updateTable("executions").set({ lease_owner: workerId }).where("id", "=", executionId).execute();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime:control command validation", () => {
  test("9. an unknown command type is rejected as invalid_payload, not forwarded", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(
      JSON.stringify({
        version: 1,
        type: "execution.command",
        commandId,
        executionId,
        command: { type: "terminal.exec", payload: { cmd: "printf athernull-phase3d" } },
      }),
    );
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "invalid_payload");
    assert.equal(relay.received.filter((m) => m.type === "gateway.command").length, 0, "an unknown command type must never reach the worker");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("10. a malformed agent.message payload (missing text) is rejected as invalid_payload", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    client.ws.send(
      JSON.stringify({ version: 1, type: "execution.command", commandId, executionId, command: { type: "agent.message", payload: {} } }),
    );
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "invalid_payload");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("11. an oversized (but parseable) command text is rejected as invalid_payload via schema validation", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    const commandId = randomUUID();
    const oversizedText = "a".repeat(8001); // MAX_COMMAND_TEXT_LENGTH is 8000
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, oversizedText)));
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "invalid_payload");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("12. a raw frame exceeding the transport-level size bound is rejected generically (never JSON.parse'd)", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    // 17 KiB of padding pushes the whole frame over MAX_CONTROL_MESSAGE_BYTES
    // (16 KiB) while still being valid JSON shape-wise, if it were parsed.
    const commandId = randomUUID();
    const huge = "a".repeat(17 * 1024);
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, huge)));
    const error = await client.waitForType("error");
    assert.equal(error.code, "invalid_message");
    assert.equal(client.commandStatusesFor(commandId).length, 0, "an oversized frame must never be attributed to a specific commandId");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("13. a duplicate commandId is forwarded at most once (at-most-once, ADR-0007)", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "first send")));
    await client.waitForCommandStatus(commandId, "forwarded");
    await relay.waitForCommand(commandId);

    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "duplicate send")));
    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "duplicate_command_id");

    await new Promise((r) => setTimeout(r, 150));
    const forwardedCount = relay.received.filter(
      (m) => m.type === "gateway.command" && (m.payload as { commandId?: string })?.commandId === commandId,
    ).length;
    assert.equal(forwardedCount, 1, "a duplicate commandId must never be forwarded to the worker a second time");

    relay.ack(executionId, commandId, "accepted");
    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime:control delivery outcomes", () => {
  test("14. a worker disconnecting before acknowledgement produces an uncertain status, never a silent success/failure", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    await relay.waitForCommand(commandId);

    // Disconnect the worker relay BEFORE it acks — the deliberately ambiguous
    // delivery scenario ADR-0007 requires be surfaced as "uncertain," never
    // auto-retried and never presented as a definite failure.
    relay.disconnect();

    const uncertain = await client.waitForCommandStatus(commandId, "uncertain");
    assert.equal(uncertain.reason, "ack_timeout");

    client.close();
    await completeExecution(executionId, workerId);
  });

  test("15. an explicit worker rejection produces a rejected status", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    await relay.waitForCommand(commandId);
    relay.ack(executionId, commandId, "rejected", "worker declined");

    const rejected = await client.waitForCommandStatus(commandId, "rejected");
    assert.equal(rejected.reason, "worker declined");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("16. an explicit downstream (Agent Server) failure produces a failed status", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    await relay.waitForCommand(commandId);
    relay.ack(executionId, commandId, "failed", "agent server returned 500");

    const failed = await client.waitForCommandStatus(commandId, "failed");
    assert.equal(failed.reason, "agent server returned 500");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("17. a normal execution.event after an accepted command upgrades it to executed (best-effort heuristic)", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId)));
    await relay.waitForCommand(commandId);
    relay.ack(executionId, commandId, "accepted");
    await client.waitForCommandStatus(commandId, "accepted");

    await postExecutionEvents(executionId, workerId, "agent responded to the command");
    await client.waitForCommandStatus(commandId, "executed");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });

  test("18. a rejected/failed control command does not break the realtime:view event stream", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");

    // A command that will be rejected (no relay yet).
    const badCommandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, badCommandId)));
    await client.waitForCommandStatus(badCommandId, "rejected");

    // The ordinary read-only path must still work normally afterward.
    await postExecutionEvents(executionId, workerId, "still streaming fine");
    await waitFor(() => (client.messages.some((m) => m.type === "execution.event") ? true : undefined));

    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime:control business-lifecycle boundary", () => {
  test("a control command cannot mutate the task's business status", async () => {
    const { owner, taskId, executionId, workerId } = await createRunningTaskForNewOrg(randomUUID());
    const client = await connectRealtime(taskId, owner.jar.header);
    await client.waitForType("history.ready");
    const relaySocket = await connectRelay(executionId, workerId);
    const relay = new FakeWorkerRelay(relaySocket);

    const before = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();

    const commandId = randomUUID();
    client.ws.send(JSON.stringify(commandEnvelope(executionId, commandId, "please settle this task")));
    await relay.waitForCommand(commandId);
    relay.ack(executionId, commandId, "accepted");
    await client.waitForCommandStatus(commandId, "accepted");

    const after = await db.selectFrom("tasks").select(["status"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    assert.equal(after.status, before.status, "a control command must never change the task's business-lifecycle status");
    assert.equal(before.status, "RUNNING");

    relaySocket.close();
    client.close();
    await completeExecution(executionId, workerId);
  });
});

describe("realtime:control static source-level safety assertions", () => {
  const files = [
    fileURLToPath(new URL("../src/routes/realtime-gateway.ts", import.meta.url)),
    fileURLToPath(new URL("../src/routes/relay.ts", import.meta.url)),
    fileURLToPath(new URL("../src/realtime/control-registry.ts", import.meta.url)),
    fileURLToPath(new URL("../src/realtime/envelope.ts", import.meta.url)),
    fileURLToPath(new URL("../src/realtime/relay-registry.ts", import.meta.url)),
    fileURLToPath(new URL("../../../packages/contracts/src/realtime-browser.ts", import.meta.url)),
  ];

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

  test("19. SESSION_API_KEY never appears in the Phase 3D command protocol's actual code", () => {
    for (const filePath of files) {
      const codeOnly = stripComments(readFileSync(filePath, "utf8"));
      assert.ok(!codeOnly.includes("SESSION_API_KEY"), `${filePath} must never reference SESSION_API_KEY in code`);
    }
  });

  test("20. INTERNAL_API_TOKEN never appears in the browser-facing contract file", () => {
    const contractFile = fileURLToPath(new URL("../../../packages/contracts/src/realtime-browser.ts", import.meta.url));
    const codeOnly = stripComments(readFileSync(contractFile, "utf8"));
    assert.ok(!codeOnly.includes("INTERNAL_API_TOKEN"), "the browser-facing contract must never reference INTERNAL_API_TOKEN");
  });

  test("21. the browser-facing gateway route never calls anything under /internal/*", () => {
    const routeFilePath = fileURLToPath(new URL("../src/routes/realtime-gateway.ts", import.meta.url));
    const source = readFileSync(routeFilePath, "utf8");
    const codeOnly = stripComments(source);
    assert.ok(source.includes("/internal/"), "sanity check: the file's own documentation should still mention /internal/*");
    assert.ok(!codeOnly.includes("/internal/"), "/internal/* must never appear in this file's actual code");
  });

  test("22. the realtime-gateway route never writes to the tasks table (business lifecycle stays authoritative elsewhere)", () => {
    const routeFilePath = fileURLToPath(new URL("../src/routes/realtime-gateway.ts", import.meta.url));
    const codeOnly = stripComments(readFileSync(routeFilePath, "utf8"));
    assert.ok(
      !codeOnly.includes('updateTable("tasks")') && !codeOnly.includes("updateTable('tasks')"),
      "the realtime gateway must never mutate the tasks table directly — business lifecycle transitions remain exclusively routes/internal.ts's job",
    );
  });

  test("23. only agent.message is an allowed command type in ExecutionCommandTypeSchema (narrow v1 surface)", () => {
    const contractFile = fileURLToPath(new URL("../../../packages/contracts/src/realtime-browser.ts", import.meta.url));
    const source = readFileSync(contractFile, "utf8");
    const match = source.match(/ExecutionCommandTypeSchema = z\.enum\(\[([^\]]*)\]\)/);
    assert.ok(match, "expected to find ExecutionCommandTypeSchema's enum literal in the contract source");
    const enumBody = match?.[1] ?? "";
    assert.ok(enumBody.includes('"agent.message"'), "agent.message must be present as a v1 command type");
    assert.ok(
      !/terminal|bash|shell/i.test(enumBody),
      "no terminal/bash/shell command type should be silently added to the allowlist — that decision (deferred, see the ADR) must be a conscious future change, not an accidental one",
    );
  });
});
