// ADR-0015 agent gateway — integration tests against a real Postgres via the
// real Fastify app, with a fake org sandbox (HTTP + WebSocket) recording
// exactly what reaches it. Covers session auth, key injection, the funding
// gate, role checks, tenant isolation and the socket auth-frame swap.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";
process.env.NVIDIA_NIM_API_KEY = "test-nim-key-not-real";
process.env.DISCUSSION_MAX_MESSAGES = "3";

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { WebSocket, WebSocketServer } from "ws";

const { buildApp } = await import("../src/app.js");
const { setPlannerClientForTests } = await import("../src/planner.js");
const { db } = await import("../src/db.js");
const { AUTH_ORIGIN, createAwaitingFundingTask, signUpVerifiedAndSignIn } = await import("./support/app-fixtures.js");

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

// A fake org sandbox: answers every request and records it.
async function fakeSandbox() {
  const requests: Seen[] = [];
  const frames: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "sandbox=1" });
      if (req.url!.includes("/events/search")) {
        const message = (source: string, text: string) => ({ kind: "MessageEvent", source, llm_message: { content: [{ type: "text", text }] } });
        res.end(JSON.stringify({
          items: [
            message("user", "I want a /version endpoint"),
            message("agent", "Agreed scope: GET /version returns {version} with a supertest test."),
            { kind: "ActionEvent", tool_name: "finish" },
          ],
          next_page_id: null,
        }));
        return;
      }
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    requests.push({ method: "WS", url: req.url!, headers: req.headers, body: "" });
    ws.on("message", (m) => frames.push(m.toString()));
    ws.send(JSON.stringify({ kind: "MessageEvent", id: "evt-1" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, frames, close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()); }) };
}

let app: FastifyInstance;
let apiUrl: string;
let sandboxA: Awaited<ReturnType<typeof fakeSandbox>>;
let sandboxB: Awaited<ReturnType<typeof fakeSandbox>>;
type T = Awaited<ReturnType<typeof createAwaitingFundingTask>>;
let orgA: T;
let orgB: T;
const keyA = randomBytes(32).toString("hex");
const keyB = randomBytes(32).toString("hex");
const CONVERSATION = randomUUID();
let discussionId = "";

const req = (t: T, method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method: method as "GET",
    url,
    headers: { cookie: t.jar.header, origin: AUTH_ORIGIN, "x-session-api-key": "athernull-gateway", ...extra },
    payload: payload as object | undefined,
  });

before(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apiUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  sandboxA = await fakeSandbox();
  sandboxB = await fakeSandbox();
  orgA = await createAwaitingFundingTask(app);
  orgB = await createAwaitingFundingTask(app);
  for (const [t, s, k] of [[orgA, sandboxA, keyA], [orgB, sandboxB, keyB]] as const) {
    await db.insertInto("org_agent_servers").values({ organization_id: t.organizationId, base_url: s.url, session_api_key: k }).execute();
  }
});

after(async () => {
  await app.close();
  await sandboxA.close();
  await sandboxB.close();
});

describe("agent gateway HTTP", () => {
  test("requires an AtherNull session", async () => {
    const res = await app.inject({ method: "GET", url: "/oh/server_info" });
    assert.equal(res.statusCode, 401);
  });

  test("reads reach the org's own sandbox with the real key; browser credentials never do", async () => {
    const before = sandboxA.requests.length;
    const res = await req(orgA, "GET", "/oh/api/conversations?limit=5");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["set-cookie"], undefined, "sandbox cookies are not relayed");
    const seen = sandboxA.requests.at(-1)!;
    assert.equal(sandboxA.requests.length, before + 1);
    assert.equal(seen.url, "/api/conversations?limit=5");
    assert.equal(seen.headers["x-session-api-key"], keyA);
    assert.equal(seen.headers.cookie, undefined);
  });

  test("each organization only ever reaches its own sandbox", async () => {
    const beforeA = sandboxA.requests.length;
    await req(orgB, "GET", "/oh/api/settings");
    assert.equal(sandboxA.requests.length, beforeA);
    assert.equal(sandboxB.requests.at(-1)!.headers["x-session-api-key"], keyB);
  });

  test("the LLM proxy is closed", async () => {
    const before = sandboxA.requests.length;
    assert.equal((await req(orgA, "POST", "/oh/v1/chat/completions", { model: "x" })).statusCode, 403);
    assert.equal(sandboxA.requests.length, before);
  });

  test("starting a conversation starts a tool-less discussion the gateway builds itself", async () => {
    const res = await req(orgA, "POST", "/oh/api/conversations", {
      // Everything here but the message text must be ignored.
      agent: { kind: "Agent", llm: { model: "attacker/model", api_key: "x" }, tools: [{ name: "terminal" }] },
      agent_profile_id: randomUUID(),
      workspace: { kind: "LocalWorkspace", working_dir: "/" },
      initial_message: { content: [{ type: "text", text: "I want a /version endpoint" }] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const start = sandboxA.requests.findLast((r) => r.method === "POST" && r.url === "/api/conversations")!;
    const sent = JSON.parse(start.body) as {
      autotitle: boolean;
      conversation_id: string;
      agent: { tools: unknown[]; mcp_config: object; llm: { model: string; api_key: string } };
      workspace: { working_dir: string };
      tags: Record<string, string>;
      agent_profile_id?: string;
      initial_message: { content: { text: string }[] };
    };
    assert.deepEqual(sent.agent.tools, []);
    assert.deepEqual(sent.agent.mcp_config, {});
    assert.equal(sent.agent.llm.api_key, "test-nim-key-not-real");
    assert.notEqual(sent.agent.llm.model, "attacker/model");
    assert.equal(sent.agent_profile_id, undefined);
    assert.equal(sent.workspace.working_dir, `/workspace/discussions/${sent.conversation_id}`);
    assert.equal(sent.tags.athernullmode, "discussion");
    assert.equal(sent.initial_message.content[0]!.text, "I want a /version endpoint");
    // Titled by the gateway from the user's words, not by the sandbox model.
    assert.equal(sent.autotitle, false);
    const titled = sandboxA.requests.at(-1)!;
    assert.equal(titled.method, "PATCH");
    assert.equal(titled.url, `/api/conversations/${sent.conversation_id}`);
    assert.equal(JSON.parse(titled.body).title, "I want a /version endpoint");
    const row = await db.selectFrom("discussion_conversations").selectAll().where("conversation_id", "=", sent.conversation_id).executeTakeFirst();
    assert.equal(row?.organization_id, orgA.organizationId);
    discussionId = sent.conversation_id;
  });

  test("a discussion accepts chat (within its cap) but nothing that changes the agent", async () => {
    const url = `/oh/api/conversations/${discussionId}`;
    assert.equal((await req(orgA, "POST", `${url}/events`, { content: [{ type: "text", text: "Node/Express" }] })).statusCode, 200);
    assert.equal((await req(orgA, "POST", `${url}/run`, {})).statusCode, 200);
    // Cap is 3 in this file: the opening message + two more.
    assert.equal((await req(orgA, "POST", `${url}/events`, { content: [] })).statusCode, 429);
    // Switching the model or forking a discussion is funded-build only.
    assert.equal((await req(orgA, "POST", `${url}/switch_llm`, {})).statusCode, 402);
    assert.equal((await req(orgA, "POST", `${url}/fork`, {})).statusCode, 402);
    // Another org cannot chat in org A's discussion.
    assert.equal((await req(orgB, "POST", `${url}/events`, { content: [] })).statusCode, 402);
  });

  test("agent work needs the conversation to be this org's funded, running build", async () => {
    const url = `/oh/api/conversations/${CONVERSATION}/events`;
    assert.equal((await req(orgA, "POST", url, { content: [] })).statusCode, 402);

    await db.updateTable("tasks").set({ status: "RUNNING" }).where("id", "=", orgA.taskId).execute();
    const execution = await db
      .insertInto("executions")
      .values({ task_id: orgA.taskId, status: "RUNNING", conversation_id: CONVERSATION, started_at: new Date() })
      .returning("id")
      .executeTakeFirstOrThrow();
    try {
      const ok = await req(orgA, "POST", url, { content: [{ type: "text", text: "hi" }] });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.match(sandboxA.requests.at(-1)!.body, /"hi"/);
      // Another org cannot drive org A's running build.
      assert.equal((await req(orgB, "POST", url, { content: [] })).statusCode, 402);
    } finally {
      await db.updateTable("executions").set({ status: "FAILED" }).where("id", "=", execution.id).execute();
      await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", orgA.taskId).execute();
    }
    assert.equal((await req(orgA, "POST", url, { content: [] })).statusCode, 402, "only while RUNNING");
  });

  test("a discussion becomes a plan from its transcript, read server-side; other orgs cannot use it", async () => {
    let plannerInput = "";
    setPlannerClientForTests(async (prompt) => {
      plannerInput = prompt;
      return {
        goal: "Add GET /version",
        scope: { included: ["route"], excluded: [] },
        deliverables: ["route", "test"],
        implementationPlan: ["edit app"],
        assumptions: [],
        acceptanceCriteria: ["returns version"],
        infrastructureRequirements: [],
        risks: [],
        resourceEstimate: { complexity: 0.2, estimatedDurationHours: { min: 1, max: 2 }, inferenceRequirements: { estimatedTier: "fast" } },
      };
    });
    try {
      const res = await req(orgA, "POST", `/v1/projects/${orgA.projectId}/estimates`, { discussionId });
      assert.equal(res.statusCode, 201, res.body);
      assert.match(plannerInput, /^\[Planned from a canvas discussion\]/);
      assert.match(plannerInput, /Customer: I want a \/version endpoint/);
      assert.match(plannerInput, /Agent: Agreed scope/);
      assert.doesNotMatch(plannerInput, /finish/);

      const foreign = await req(orgB, "POST", `/v1/projects/${orgB.projectId}/estimates`, { discussionId });
      assert.equal(foreign.statusCode, 404, foreign.body);
      const both = await req(orgA, "POST", `/v1/projects/${orgA.projectId}/estimates`, { discussionId, prompt: "x" });
      assert.equal(both.statusCode, 400);

      const list = JSON.parse((await req(orgA, "GET", "/v1/discussions")).body) as { id: string }[];
      assert.ok(list.some((d) => d.id === discussionId));
      const otherList = JSON.parse((await req(orgB, "GET", "/v1/discussions")).body) as { id: string }[];
      assert.ok(!otherList.some((d) => d.id === discussionId));
    } finally {
      setPlannerClientForTests(null);
    }
  });

  test("members can read; only owners/admins can configure the sandbox", async () => {
    const suffix = randomUUID();
    const member = await signUpVerifiedAndSignIn(app, `member-${suffix}@example.com`, "correct horse battery", "Member");
    await sql`insert into "member" (id, "organizationId", "userId", role, "createdAt") values (gen_random_uuid(), ${orgA.organizationId}, ${member.userId}, 'member', now())`.execute(db);
    const setActive = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie: member.jar.header, origin: AUTH_ORIGIN },
      payload: { organizationId: orgA.organizationId },
    });
    assert.equal(setActive.statusCode, 200, setActive.body);
    member.jar.absorb(setActive);
    member.jar.dropSessionCache();
    const m = { jar: member.jar } as T;
    assert.equal((await req(m, "GET", "/oh/api/settings")).statusCode, 200);
    assert.equal((await req(m, "PATCH", "/oh/api/settings", { agent_settings_diff: {} })).statusCode, 403);
    assert.equal((await req(m, "GET", "/oh/api/settings/secrets/GITHUB_TOKEN")).statusCode, 403);
    assert.equal((await req(orgA, "PATCH", "/oh/api/settings", { agent_settings_diff: {} })).statusCode, 200);
  });

  test("mutations need a trusted Origin", async () => {
    const res = await req(orgA, "PATCH", "/oh/api/settings", {}, { origin: "https://evil.example" });
    assert.equal(res.statusCode, 403);
  });

  test("an org without a sandbox gets 503, not someone else's", async () => {
    await db.deleteFrom("org_agent_servers").where("organization_id", "=", orgB.organizationId).execute();
    try {
      assert.equal((await req(orgB, "GET", "/oh/api/settings")).statusCode, 503);
    } finally {
      await db.insertInto("org_agent_servers").values({ organization_id: orgB.organizationId, base_url: sandboxB.url, session_api_key: keyB }).execute();
    }
  });
});

describe("agent gateway WebSockets", () => {
  function open(t: T, path: string) {
    return new WebSocket(`${apiUrl.replace("http", "ws")}${path}`, { headers: { cookie: t.jar.header, origin: AUTH_ORIGIN } });
  }

  test("events socket: browser auth frame dropped, real key used upstream, unfunded chat refused", async () => {
    const framesBefore = sandboxA.frames.length;
    const ws = open(orgA, `/oh/sockets/events/${CONVERSATION}?resend_mode=all`);
    const first = await new Promise<string>((resolve, reject) => {
      ws.once("message", (m) => resolve(m.toString()));
      ws.once("error", reject);
    });
    assert.match(first, /MessageEvent/, "upstream events reach the browser");
    ws.send(JSON.stringify({ type: "auth", session_api_key: "athernull-gateway" }));
    ws.send(JSON.stringify({ role: "user", content: [{ type: "text", text: "do work" }], run: true }));
    const refusal = await new Promise<string>((resolve) => ws.once("message", (m) => resolve(m.toString())));
    assert.match(refusal, /funded AtherNull build/);
    ws.close();

    const upstreamConn = sandboxA.requests.filter((r) => r.method === "WS").at(-1)!;
    assert.equal(upstreamConn.url, `/sockets/events/${CONVERSATION}?resend_mode=all`);
    assert.equal(upstreamConn.headers["x-session-api-key"], keyA);
    const frames = sandboxA.frames.slice(framesBefore);
    assert.deepEqual(frames.map((f) => JSON.parse(f) as { type?: string; session_api_key?: string }), [{ type: "auth", session_api_key: keyA }]);
  });

  test("sockets refuse untrusted origins and anonymous users", async () => {
    const bad = new WebSocket(`${apiUrl.replace("http", "ws")}/oh/sockets/bash-events`, { headers: { cookie: orgA.jar.header, origin: "https://evil.example" } });
    const anon = new WebSocket(`${apiUrl.replace("http", "ws")}/oh/sockets/bash-events`, { headers: { origin: AUTH_ORIGIN } });
    for (const ws of [bad, anon]) {
      const code = await new Promise<number>((resolve) => ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
      assert.ok(code === 401 || code === 403, `got ${code}`);
    }
  });
});
