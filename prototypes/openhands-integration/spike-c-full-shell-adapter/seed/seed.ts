// Spike C seed script. Creates ONE real org + project + agent profile +
// funded task + claimed execution + inserted events + completed execution,
// through apps/api's real HTTP surface (session-cookie routes) and its
// existing internal worker endpoints - the exact zero-cost pattern
// apps/api/test/job-lifecycle.test.ts's createFundedAndRunningTask() uses,
// just driven over real HTTP against a running dev server instead of
// Fastify's inject(). No LLM calls, no Solana activity: /internal/executions
// /claim + /events + /complete require neither.
//
// Prereqs (see ../README.md):
//   - infrastructure/docker-compose.yml's postgres running, athernull_dev
//     migrated (both already true on this machine - see README "Environment"
//     section for how that was confirmed).
//   - apps/api's dev server running on http://localhost:3001 (`pnpm --filter
//     @athernull/api dev`, or plain `npm run dev` inside apps/api). NOT
//     modified - only run, per the spike's isolation rules.
//   - apps/api/.env's DATABASE_URL, BETTER_AUTH_SECRET, INTERNAL_API_TOKEN
//     used here match what the running dev server was started with.
//
// Only mutation this script performs directly against Postgres (bypassing
// HTTP) is: (a) flipping the freshly-signed-up user's emailVerified flag,
// the same bypass job-lifecycle.test.ts uses instead of sending a real
// email, and (b) inserting the agent_profiles row, because apps/api has no
// public POST /v1/agent-profiles endpoint (only GET) - the test helper
// (seedProjectAndAgentProfile) does the same direct insert. Both write only
// to the local dev Postgres named in DATABASE_URL below.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const AUTH_ORIGIN = process.env.WEB_APP_URL ?? "http://localhost:3000";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_dev";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

if (!INTERNAL_API_TOKEN) {
  console.error(
    "INTERNAL_API_TOKEN is not set. Run with the same value apps/api/.env's " +
      "dev server was started with, e.g.:\n" +
      "  INTERNAL_API_TOKEN=<value from apps/api/.env> npm run seed",
  );
  process.exit(1);
}

// Distinctive, grep-able objective string - this is what the Playwright
// smoke test asserts actually rendered through the whole adapter chain
// (proving it's real AtherNull data, not OpenHands' own mock fixtures).
const DISTINCTIVE_OBJECTIVE =
  "[Spike-C probe 7f2a91] Add a rate-limited GET /health endpoint";

class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    const setCookies =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie ===
      "function"
        ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      this.cookies.set(name, value);
    }
  }

  // Mirrors job-lifecycle.test.ts's CookieJar.dropSessionCache(): the signed
  // 5-minute session_data cache cookie would otherwise keep resolving to the
  // pre-org-switch active organization until it expires.
  dropSessionCache(): void {
    this.cookies.delete("better-auth.session_data");
  }

  get header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function api(
  method: string,
  urlPath: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (method === "POST") headers.origin = AUTH_ORIGIN;

  return fetch(`${API_BASE}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function assertOk(res: Response, label: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const email = `spike-c-${suffix}@example.com`;
  // Random, not a well-known phrase - haveIBeenPwned plugin (auth.ts) rejects
  // breached passwords, and the famous "correct horse battery staple" xkcd
  // phrase is itself in breach corpora.
  const password = `Sp1ke-C-${randomUUID()}`;
  const name = "Spike C Owner";

  console.log(`[seed] signing up ${email} ...`);
  const signUpRes = await api("POST", "/api/auth/sign-up/email", {
    body: { email, password, name },
  });
  await assertOk(signUpRes, "sign-up");

  console.log("[seed] bypassing email verification via direct DB update (same mechanism apps/api/test/job-lifecycle.test.ts uses - no real email sent) ...");
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await pg.query('update "user" set "emailVerified" = true where "email" = $1', [email]);

  const jar = new CookieJar();
  console.log("[seed] signing in ...");
  const signInRes = await api("POST", "/api/auth/sign-in/email", {
    body: { email, password },
  });
  const signInBody = (await assertOk(signInRes, "sign-in")) as { user: { id: string } };
  jar.absorb(signInRes);
  const userId = signInBody.user.id;

  console.log("[seed] creating organization ...");
  const orgSlug = `spike-c-${suffix}`;
  const createOrgRes = await api("POST", "/api/auth/organization/create", {
    cookie: jar.header,
    body: { name: `Spike C Org ${suffix}`, slug: orgSlug },
  });
  const orgBody = (await assertOk(createOrgRes, "create-org")) as { id: string };
  jar.absorb(createOrgRes);
  jar.dropSessionCache();
  const organizationId = orgBody.id;

  console.log("[seed] creating project (POST /v1/projects) ...");
  const projectRes = await api("POST", "/v1/projects", {
    cookie: jar.header,
    body: { permittedRepository: "github.com/athernull/spike-c-example" },
  });
  const projectBody = (await assertOk(projectRes, "create-project")) as { id: string };
  const projectId = projectBody.id;

  // No public POST /v1/agent-profiles endpoint exists (apps/api/src/routes/
  // agent-profiles.ts only has GET) - direct insert, same as job-lifecycle
  // .test.ts's seedProjectAndAgentProfile() helper.
  console.log("[seed] inserting agent profile directly (no public create endpoint exists, mirrors the test helper) ...");
  const agentProfileResult = await pg.query(
    `insert into agent_profiles (organization_id, model_tiers, policy_version)
     values ($1, $2, $3) returning id`,
    [
      organizationId,
      JSON.stringify([
        { tier: "fast", model: "anthropic/claude-haiku-4-5-20251001", maxComplexity: 1 },
      ]),
      "v1",
    ],
  );
  const agentProfileId = agentProfileResult.rows[0].id as string;

  console.log(`[seed] creating task: "${DISTINCTIVE_OBJECTIVE}" ...`);
  const createTaskRes = await api("POST", "/v1/jobs", {
    cookie: jar.header,
    body: {
      projectId,
      repositoryRevision: "abc123",
      objective: DISTINCTIVE_OBJECTIVE,
      acceptanceCriteria: ["Returns 200", "Rate-limited to 10 req/s per IP"],
      agentProfileId,
      budgetMinor: 5000,
      currency: "usd",
    },
  });
  const taskBody = (await assertOk(createTaskRes, "create-task")) as { id: string };
  const taskId = taskBody.id;

  console.log("[seed] funding task (POST /v1/jobs/:id/fund) ...");
  const fundRes = await api("POST", `/v1/jobs/${taskId}/fund`, { cookie: jar.header });
  await assertOk(fundRes, "fund");

  console.log("[seed] claiming via /internal/executions/claim (draining any stragglers first) ...");
  let executionId: string | null = null;
  let ownWorkerId: string | null = null;
  for (let attempt = 0; attempt < 50 && executionId === null; attempt++) {
    const workerId = `worker-${randomUUID()}`;
    const claimRes = await api("POST", "/internal/executions/claim", {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId },
    });
    if (claimRes.status === 204) {
      throw new Error("claim returned 204 (no QUEUED task) before finding our own task");
    }
    const claimed = (await assertOk(claimRes, "claim")) as { jobId: string; executionId: string };

    if (claimed.jobId === taskId) {
      executionId = claimed.executionId;
      ownWorkerId = workerId;
      break;
    }

    // Straggler from an earlier run against this shared dev DB - drain it
    // with a success complete so it stops clogging the claim queue, exactly
    // as job-lifecycle.test.ts's createFundedAndRunningTask() does.
    console.log(`[seed]   claimed a straggler task ${claimed.jobId}, draining it ...`);
    const drainRes = await api("POST", `/internal/executions/${claimed.executionId}/complete`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId, outcome: "success" },
    });
    await assertOk(drainRes, "drain-complete");
  }
  if (!executionId || !ownWorkerId) {
    throw new Error("claim never returned this seed's own task within 50 attempts");
  }
  console.log(`[seed] claimed our task's execution: ${executionId}`);

  // Agent Server integration §2 (apps/api/src/routes/internal.ts): stamps a
  // conversation id onto the execution, mirroring what agent_server_adapter.py
  // does right after creating a real OpenHands conversation. This is what
  // apps/web/lib/types.ts's Execution.conversationId (and hence the
  // adapter's AppConversation.id) is keyed on.
  const conversationId = randomUUID();
  console.log(`[seed] stamping conversation id ${conversationId} onto the execution ...`);
  const convRes = await api("POST", `/internal/executions/${executionId}/conversation`, {
    bearer: INTERNAL_API_TOKEN,
    body: { workerId: ownWorkerId, conversationId },
  });
  await assertOk(convRes, "set-conversation-id");

  console.log("[seed] inserting execution events (adapted from Spike B's synthetic fixtures) ...");
  const events = buildSeedEvents();
  const eventsRes = await api("POST", `/internal/executions/${executionId}/events`, {
    bearer: INTERNAL_API_TOKEN,
    body: { workerId: ownWorkerId, events },
  });
  await assertOk(eventsRes, "insert-events");
  console.log(`[seed]   inserted ${events.length} events`);

  console.log("[seed] completing execution (outcome: success -> task moves to VERIFYING) ...");
  const completeRes = await api("POST", `/internal/executions/${executionId}/complete`, {
    bearer: INTERNAL_API_TOKEN,
    body: { workerId: ownWorkerId, outcome: "success" },
  });
  const completedTask = await assertOk(completeRes, "complete");

  await pg.end();

  const output = {
    createdAt: new Date().toISOString(),
    apiBase: API_BASE,
    ownerEmail: email,
    ownerPassword: password,
    organizationId,
    projectId,
    agentProfileId,
    taskId,
    executionId,
    conversationId,
    distinctiveObjective: DISTINCTIVE_OBJECTIVE,
    finalTaskStatus: (completedTask as { status: string }).status,
    eventCount: events.length,
  };

  const outPath = path.join(__dirname, "seed-output.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("\n[seed] DONE. Summary:");
  console.log(JSON.stringify(output, null, 2));
  console.log(`\n[seed] Written to ${outPath}`);
}

// AtherNull's raw ExecutionEvent wire shape is {id, kind, occurredAt,
// payload} (apps/web/lib/types.ts / apps/api/src/routes/internal.ts's events
// schema) - already exactly what Spike B's synthetic fixtures
// (execution-events.synthetic.ts) were authored against, so this is a
// straight re-timestamp + id-namespacing pass, not a shape translation.
// Content is adapted (not copied verbatim) so timestamps land "recently"
// relative to this seed run instead of the fixture's fixed 2026-09-01 stamp.
function buildSeedEvents(): { id: string; kind: string; occurredAt: string; payload: unknown }[] {
  const base = Date.now() - 5 * 60_000; // started 5 minutes ago
  const t = (offsetSeconds: number) => new Date(base + offsetSeconds * 1000).toISOString();
  // execution_events.id is a real `uuid` column (0007_execution_events.sql:
  // "id is the OpenHands event's own uuid, not a generated one") - unlike
  // Spike B's fixture ids (plain strings like "syn-3-terminal-action"),
  // every id here must be an actual UUID. Generated once so the two
  // action/observation pairs below can cross-reference each other via
  // action_id, mirroring how a real ObservationEvent.action_id points back
  // at its ActionEvent's own uuid.
  const id3Action = randomUUID();
  const id4Action = randomUUID();
  const id5Action = randomUUID();

  return [
    {
      id: randomUUID(),
      kind: "MessageEvent",
      occurredAt: t(0),
      payload: {
        source: "user",
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "Add a rate-limited /health endpoint to the API." }],
        },
        activated_skills: [],
        extended_content: [],
      },
    },
    {
      id: randomUUID(),
      kind: "MessageEvent",
      occurredAt: t(2),
      payload: {
        source: "agent",
        llm_message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll add a GET /health route with a per-IP rate limit and a passing test." },
          ],
        },
        reasoning_content:
          "A health-check endpoint should stay cheap and dependency-free, but the acceptance criteria call out rate limiting explicitly, so that needs its own middleware rather than being skipped.",
        activated_skills: [],
        extended_content: [],
      },
    },
    {
      id: id3Action,
      kind: "ActionEvent",
      occurredAt: t(4),
      payload: {
        tool_name: "terminal",
        thought: [],
        action: {
          kind: "TerminalAction",
          command: "npm run test -- health.test.ts",
          is_input: false,
          timeout: null,
          reset: false,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(6),
      payload: {
        action_id: id3Action,
        observation: {
          kind: "TerminalObservation",
          content: [{ type: "text", text: "PASS health.test.ts\n  ✓ GET /health returns 200 (4ms)\n  ✓ 11th request in 1s is rate-limited (429)" }],
          command: "npm run test -- health.test.ts",
          exit_code: 0,
          is_error: false,
          timeout: false,
        },
      },
    },
    {
      id: id4Action,
      kind: "ActionEvent",
      occurredAt: t(8),
      payload: {
        tool_name: "file_editor",
        thought: [],
        action: {
          kind: "FileEditorAction",
          command: "create",
          path: "/workspace/project/src/routes/health.ts",
          file_text:
            "import rateLimit from \"../rate-limit.js\";\n\nexport function healthRoute(app) {\n  app.get(\"/health\", { preHandler: rateLimit(10) }, async () => ({ status: \"ok\" }));\n}\n",
          old_str: null,
          new_str: null,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(9),
      payload: {
        action_id: id4Action,
        observation: {
          kind: "FileEditorObservation",
          command: "create",
          content: [{ type: "text", text: "Created /workspace/project/src/routes/health.ts" }],
          output: "Created /workspace/project/src/routes/health.ts",
          path: "/workspace/project/src/routes/health.ts",
          prev_exist: false,
        },
      },
    },
    {
      id: id5Action,
      kind: "ActionEvent",
      occurredAt: t(11),
      payload: {
        tool_name: "file_editor",
        thought: [],
        action: {
          kind: "FileEditorAction",
          command: "str_replace",
          path: "/workspace/project/src/app.ts",
          old_str: "app.get('/status', statusHandler);",
          new_str: "app.get('/status', statusHandler);\nhealthRoute(app);",
          file_text: null,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(12),
      payload: {
        action_id: id5Action,
        observation: {
          kind: "FileEditorObservation",
          command: "str_replace",
          content: [{ type: "text", text: "The file /workspace/project/src/app.ts has been edited." }],
          output: "The file /workspace/project/src/app.ts has been edited.",
          path: "/workspace/project/src/app.ts",
          prev_exist: true,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ActionEvent",
      occurredAt: t(14),
      payload: {
        tool_name: "finish",
        thought: [],
        reasoning_content: "Both acceptance criteria are met: the route returns 200 and the 11th request in a 1s window is rejected with 429.",
        action: {
          kind: "FinishAction",
          message: "Added a rate-limited GET /health endpoint with a passing test covering both the 200 and 429 cases.",
        },
      },
    },
  ];
}

main().catch((err) => {
  console.error("[seed] FAILED:", err);
  process.exit(1);
});
