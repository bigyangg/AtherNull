// Spike F seed script (Phase 1: adapter/backend feature work only).
//
// Extends the existing Spike C seeded org/project/agent-profile (read from
// ../spike-c-full-shell-adapter/seed/seed-output.json, reusing the same
// owner session rather than signing up a fresh user) with ONE NEW task that
// exercises a real, non-fabricated multi-attempt journey:
//
//   attempt 1 (RUNNING) --outcome:"failure"--> FAILED --auto-retry--> QUEUED
//   attempt 2 (RUNNING) --outcome:"success"--> VERIFYING
//                        --POST /verify {PASS}--> AWAITING_ACCEPTANCE
//                        --POST /accept--> SETTLED
//
// The auto-retry step (FAILED -> QUEUED) is NOT invented for this spike: it
// is apps/api/src/routes/internal.ts's real MAX_EXECUTION_ATTEMPTS=3 policy,
// triggered by POST /internal/executions/:id/complete {outcome:"failure"}
// while the task has fewer than 3 execution rows total - confirmed by
// reading that handler before writing this script (see Spike F's plan doc
// and this session's report for the exact line numbers). No raw SQL is used
// to fabricate a second execution row - both executions are created only by
// calling POST /internal/executions/claim twice, exactly as a real worker
// would.
//
// Every mutation here is one of the same zero-cost, zero-LLM, zero-Solana
// internal/test-only endpoints apps/api/test/job-lifecycle.test.ts and
// spike-c-full-shell-adapter/seed/seed.ts already use. No new mutation
// category is introduced.
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const AUTH_ORIGIN = process.env.WEB_APP_URL ?? "http://localhost:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

if (!INTERNAL_API_TOKEN) {
  console.error(
    "INTERNAL_API_TOKEN is not set. Run with the same value apps/api/.env's " +
      "dev server was started with, e.g.:\n" +
      "  INTERNAL_API_TOKEN=<value from apps/api/.env> node seed-journey-data.mjs",
  );
  process.exit(1);
}

// Reuses Spike C's already-seeded org/project/agent-profile/owner instead of
// signing up a new user - this is a read of that spike's own output, not a
// dependency on its adapter or mapping code (which is being changed here).
const baseSeedPath = path.resolve(
  __dirname,
  "..",
  "spike-c-full-shell-adapter",
  "seed",
  "seed-output.json",
);
let base;
try {
  base = JSON.parse(readFileSync(baseSeedPath, "utf8"));
} catch (err) {
  console.error(
    `Could not read ${baseSeedPath} - run spike-c-full-shell-adapter/seed/seed.ts ` +
      "first (see its README), or point BASE_SEED_PATH at an equivalent file.",
  );
  throw err;
}

const DISTINCTIVE_OBJECTIVE =
  "[Spike-F journey 3c91de] Add a request-count /metrics endpoint (retried once)";

class CookieJar {
  cookies = new Map();

  absorb(res) {
    const setCookies =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  // Mirrors seed.ts's CookieJar.dropSessionCache(): the signed 5-minute
  // session_data cache cookie would otherwise keep resolving to whichever
  // org was active before this script's set-active call.
  dropSessionCache() {
    this.cookies.delete("better-auth.session_data");
  }

  get header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function api(method, urlPath, opts = {}) {
  const headers = {};
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

async function assertOk(res, label) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} failed: ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Same fixture-content pattern as seed.ts's buildSeedEvents() - adapted
// (not copied verbatim) per attempt so timestamps land recently and the two
// attempts' content is distinguishable when read back through the adapter.
function buildFailedAttemptEvents() {
  const base = Date.now() - 10 * 60_000; // started 10 minutes ago
  const t = (offsetSeconds) => new Date(base + offsetSeconds * 1000).toISOString();
  const actionId = randomUUID();
  return [
    {
      id: randomUUID(),
      kind: "MessageEvent",
      occurredAt: t(0),
      payload: {
        source: "user",
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "Add a /metrics endpoint that reports request count." }],
        },
        activated_skills: [],
        extended_content: [],
      },
    },
    {
      id: actionId,
      kind: "ActionEvent",
      occurredAt: t(3),
      payload: {
        tool_name: "terminal",
        thought: [],
        action: {
          kind: "TerminalAction",
          command: "npm run test -- metrics.test.ts",
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
        action_id: actionId,
        observation: {
          kind: "TerminalObservation",
          content: [
            {
              type: "text",
              text: "FAIL metrics.test.ts\n  ✗ GET /metrics returns a request count (timeout waiting for dependency 'redis-mock')",
            },
          ],
          command: "npm run test -- metrics.test.ts",
          exit_code: 1,
          is_error: true,
          timeout: false,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ActionEvent",
      occurredAt: t(8),
      payload: {
        tool_name: "finish",
        thought: [],
        reasoning_content:
          "The test harness's redis-mock dependency isn't available in this attempt's sandbox - reporting failure so the task can retry rather than guessing at a workaround.",
        action: {
          kind: "FinishAction",
          message: "Attempt failed: test dependency 'redis-mock' unavailable, no code change committed.",
        },
      },
    },
  ];
}

// Full happy-path attempt: message -> passing terminal run -> two
// file-editor action/observation pairs (so the adapter's old_content/
// new_content enrichment has real create + str_replace cases to exercise,
// same as spike-c-full-shell-adapter/seed/seed.ts's own fixture shape) ->
// finish.
function buildSucceededAttemptEvents() {
  const base = Date.now() - 5 * 60_000; // started 5 minutes ago
  const t = (offsetSeconds) => new Date(base + offsetSeconds * 1000).toISOString();
  const idTerminalAction = randomUUID();
  const idCreateAction = randomUUID();
  const idEditAction = randomUUID();

  return [
    {
      id: randomUUID(),
      kind: "MessageEvent",
      occurredAt: t(0),
      payload: {
        source: "user",
        llm_message: {
          role: "user",
          content: [{ type: "text", text: "Add a /metrics endpoint that reports request count." }],
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
            {
              type: "text",
              text: "Retrying without the redis-mock dependency this time - I'll track the request count in-process instead.",
            },
          ],
        },
        reasoning_content:
          "The previous attempt failed because the sandbox had no redis-mock available. An in-memory counter satisfies the acceptance criteria without that dependency.",
        activated_skills: [],
        extended_content: [],
      },
    },
    {
      id: idCreateAction,
      kind: "ActionEvent",
      occurredAt: t(4),
      payload: {
        tool_name: "file_editor",
        thought: [],
        action: {
          kind: "FileEditorAction",
          command: "create",
          path: "/workspace/project/src/routes/metrics.ts",
          file_text:
            "let requestCount = 0;\n\nexport function metricsRoute(app) {\n  app.addHook(\"onRequest\", async () => {\n    requestCount += 1;\n  });\n  app.get(\"/metrics\", async () => ({ requestCount }));\n}\n",
          old_str: null,
          new_str: null,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(5),
      payload: {
        action_id: idCreateAction,
        observation: {
          kind: "FileEditorObservation",
          command: "create",
          content: [{ type: "text", text: "Created /workspace/project/src/routes/metrics.ts" }],
          output: "Created /workspace/project/src/routes/metrics.ts",
          path: "/workspace/project/src/routes/metrics.ts",
          prev_exist: false,
        },
      },
    },
    {
      id: idEditAction,
      kind: "ActionEvent",
      occurredAt: t(7),
      payload: {
        tool_name: "file_editor",
        thought: [],
        action: {
          kind: "FileEditorAction",
          command: "str_replace",
          path: "/workspace/project/src/app.ts",
          old_str: "app.get('/status', statusHandler);",
          new_str: "app.get('/status', statusHandler);\nmetricsRoute(app);",
          file_text: null,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(8),
      payload: {
        action_id: idEditAction,
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
      id: idTerminalAction,
      kind: "ActionEvent",
      occurredAt: t(10),
      payload: {
        tool_name: "terminal",
        thought: [],
        action: {
          kind: "TerminalAction",
          command: "npm run test -- metrics.test.ts",
          is_input: false,
          timeout: null,
          reset: false,
        },
      },
    },
    {
      id: randomUUID(),
      kind: "ObservationEvent",
      occurredAt: t(12),
      payload: {
        action_id: idTerminalAction,
        observation: {
          kind: "TerminalObservation",
          content: [{ type: "text", text: "PASS metrics.test.ts\n  ✓ GET /metrics returns a request count (3ms)" }],
          command: "npm run test -- metrics.test.ts",
          exit_code: 0,
          is_error: false,
          timeout: false,
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
        reasoning_content: "The acceptance criteria are met on this retry: /metrics reports a request count without the unavailable dependency.",
        action: {
          kind: "FinishAction",
          message: "Added an in-process /metrics endpoint (request count) on the second attempt, after the first attempt's dependency failure.",
        },
      },
    },
  ];
}

async function main() {
  console.log(`[seed-journey] signing in as existing Spike C owner ${base.ownerEmail} ...`);
  const jar = new CookieJar();
  const signInRes = await api("POST", "/api/auth/sign-in/email", {
    body: { email: base.ownerEmail, password: base.ownerPassword },
  });
  await assertOk(signInRes, "sign-in");
  jar.absorb(signInRes);

  console.log(`[seed-journey] switching active organization to ${base.organizationId} ...`);
  const setActiveRes = await api("POST", "/api/auth/organization/set-active", {
    cookie: jar.header,
    body: { organizationId: base.organizationId },
  });
  await assertOk(setActiveRes, "set-active-org");
  jar.absorb(setActiveRes);
  jar.dropSessionCache();

  console.log(`[seed-journey] creating task: "${DISTINCTIVE_OBJECTIVE}" ...`);
  const createTaskRes = await api("POST", "/v1/jobs", {
    cookie: jar.header,
    body: {
      projectId: base.projectId,
      repositoryRevision: "def456",
      objective: DISTINCTIVE_OBJECTIVE,
      acceptanceCriteria: [
        "GET /metrics returns a request count",
        "Succeeds on retry after a transient dependency failure",
      ],
      agentProfileId: base.agentProfileId,
      budgetMinor: 5000,
      currency: "usd",
    },
  });
  const taskBody = await assertOk(createTaskRes, "create-task");
  const taskId = taskBody.id;

  console.log("[seed-journey] funding task (POST /v1/jobs/:id/fund) ...");
  await assertOk(await api("POST", `/v1/jobs/${taskId}/fund`, { cookie: jar.header }), "fund");

  // Drains any QUEUED stragglers from earlier/concurrent runs against this
  // shared dev DB before finding our own task, same pattern seed.ts uses.
  async function claimOwnTask() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const workerId = `worker-${randomUUID()}`;
      const claimRes = await api("POST", "/internal/executions/claim", {
        bearer: INTERNAL_API_TOKEN,
        body: { workerId },
      });
      if (claimRes.status === 204) {
        throw new Error("claim returned 204 (no QUEUED task) before finding our own task");
      }
      const claimed = await assertOk(claimRes, "claim");
      if (claimed.jobId === taskId) {
        return { executionId: claimed.executionId, workerId };
      }
      console.log(`[seed-journey]   claimed a straggler task ${claimed.jobId}, draining it ...`);
      await assertOk(
        await api("POST", `/internal/executions/${claimed.executionId}/complete`, {
          bearer: INTERNAL_API_TOKEN,
          body: { workerId, outcome: "success" },
        }),
        "drain-complete",
      );
    }
    throw new Error("claim never returned this seed's own task within 50 attempts");
  }

  // --- Attempt 1: fails, triggers apps/api's real auto-retry (FAILED -> QUEUED) ---
  console.log("[seed-journey] claiming attempt 1 ...");
  const attempt1 = await claimOwnTask();
  console.log(`[seed-journey]   attempt 1 execution: ${attempt1.executionId}`);

  const conversationId1 = randomUUID();
  await assertOk(
    await api("POST", `/internal/executions/${attempt1.executionId}/conversation`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt1.workerId, conversationId: conversationId1 },
    }),
    "set-conversation-1",
  );

  const events1 = buildFailedAttemptEvents();
  await assertOk(
    await api("POST", `/internal/executions/${attempt1.executionId}/events`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt1.workerId, events: events1 },
    }),
    "insert-events-1",
  );
  console.log(`[seed-journey]   inserted ${events1.length} events for attempt 1`);

  console.log("[seed-journey] completing attempt 1 with outcome:\"failure\" ...");
  const afterAttempt1 = await assertOk(
    await api("POST", `/internal/executions/${attempt1.executionId}/complete`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt1.workerId, outcome: "failure" },
    }),
    "complete-1",
  );
  console.log(`[seed-journey]   task status after attempt 1: ${afterAttempt1.status}`);
  if (afterAttempt1.status !== "QUEUED") {
    throw new Error(
      `Expected apps/api's real MAX_EXECUTION_ATTEMPTS auto-retry to put the task back in QUEUED ` +
        `after 1 failed attempt (cap is 3) - got "${afterAttempt1.status}" instead. Stopping rather ` +
        "than fabricating a second execution some other way.",
    );
  }

  // --- Attempt 2: succeeds ---
  console.log("[seed-journey] claiming attempt 2 (auto-retried) ...");
  const attempt2 = await claimOwnTask();
  console.log(`[seed-journey]   attempt 2 execution: ${attempt2.executionId}`);

  const conversationId2 = randomUUID();
  await assertOk(
    await api("POST", `/internal/executions/${attempt2.executionId}/conversation`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt2.workerId, conversationId: conversationId2 },
    }),
    "set-conversation-2",
  );

  const events2 = buildSucceededAttemptEvents();
  await assertOk(
    await api("POST", `/internal/executions/${attempt2.executionId}/events`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt2.workerId, events: events2 },
    }),
    "insert-events-2",
  );
  console.log(`[seed-journey]   inserted ${events2.length} events for attempt 2`);

  console.log("[seed-journey] completing attempt 2 with outcome:\"success\" ...");
  const afterAttempt2 = await assertOk(
    await api("POST", `/internal/executions/${attempt2.executionId}/complete`, {
      bearer: INTERNAL_API_TOKEN,
      body: { workerId: attempt2.workerId, outcome: "success" },
    }),
    "complete-2",
  );
  console.log(`[seed-journey]   task status after attempt 2: ${afterAttempt2.status}`);
  if (afterAttempt2.status !== "VERIFYING") {
    throw new Error(`Expected VERIFYING after a successful completion, got "${afterAttempt2.status}"`);
  }

  // --- Drive VERIFYING -> AWAITING_ACCEPTANCE -> SETTLED via the real, zero-cost endpoints ---
  console.log("[seed-journey] verifying (POST /v1/jobs/:id/verify {outcome:\"PASS\"}) ...");
  const verified = await assertOk(
    await api("POST", `/v1/jobs/${taskId}/verify`, {
      cookie: jar.header,
      body: {
        outcome: "PASS",
        tests: [
          { name: "GET /metrics returns a request count", passed: true },
          { name: "Succeeds on retry after a transient dependency failure", passed: true },
        ],
      },
    }),
    "verify",
  );
  console.log(`[seed-journey]   task status after verify: ${verified.status}`);
  if (verified.status !== "AWAITING_ACCEPTANCE") {
    throw new Error(`Expected AWAITING_ACCEPTANCE after verify(PASS), got "${verified.status}"`);
  }

  console.log("[seed-journey] accepting (POST /v1/jobs/:id/accept) ...");
  const accepted = await assertOk(
    await api("POST", `/v1/jobs/${taskId}/accept`, { cookie: jar.header }),
    "accept",
  );
  console.log(`[seed-journey]   task status after accept: ${accepted.status}`);
  if (accepted.status !== "SETTLED") {
    throw new Error(`Expected SETTLED after accept, got "${accepted.status}"`);
  }

  // No generated secret in this output: this script reuses Spike C's
  // existing owner session (base.ownerEmail/base.ownerPassword, read from
  // seed-output.json, never re-printed here) instead of signing up a new
  // user - so, unlike seed-output.json, this file does not need to be
  // gitignored for a leaked password.
  const output = {
    createdAt: new Date().toISOString(),
    apiBase: API_BASE,
    reusedOwnerEmail: base.ownerEmail,
    organizationId: base.organizationId,
    projectId: base.projectId,
    agentProfileId: base.agentProfileId,
    taskId,
    distinctiveObjective: DISTINCTIVE_OBJECTIVE,
    attempts: [
      {
        executionId: attempt1.executionId,
        conversationId: conversationId1,
        outcome: "failure",
        eventCount: events1.length,
      },
      {
        executionId: attempt2.executionId,
        conversationId: conversationId2,
        outcome: "success",
        eventCount: events2.length,
      },
    ],
    maxExecutionAttempts: 3,
    autoRetryConfirmed: "apps/api/src/routes/internal.ts's real FAILED->QUEUED cap, triggered live (not simulated)",
    finalTaskStatus: accepted.status,
  };

  const outPath = path.join(__dirname, "seed-journey-output.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log("\n[seed-journey] DONE. Summary:");
  console.log(JSON.stringify(output, null, 2));
  console.log(`\n[seed-journey] Written to ${outPath}`);
}

main().catch((err) => {
  console.error("[seed-journey] FAILED:", err);
  process.exit(1);
});
