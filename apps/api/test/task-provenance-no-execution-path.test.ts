// Static source test — no app boot, no DB — for the hard invariant that
// routes/task-provenance.ts can never reach execution/worker dispatch,
// conversation machinery, or payment/settlement. Complements (does not
// replace) the runtime check in task-provenance-lifecycle.test.ts. Mirrors
// apps/api/test/{estimates,budget-authorizations}-no-execution-path.test.ts
// exactly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeFilePath = path.join(here, "..", "src", "routes", "task-provenance.ts");
const source = readFileSync(routeFilePath, "utf8");

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /selectFrom\(\s*["']executions["']\s*\)/, reason: 'reads the "executions" table' },
  { pattern: /updateTable\(\s*["']executions["']\s*\)/, reason: 'writes the "executions" table' },
  { pattern: /insertInto\(\s*["']executions["']\s*\)/, reason: 'inserts into the "executions" table' },
  {
    pattern: /selectFrom\(\s*["']payment_intents["']\s*\)/,
    reason: 'reads the "payment_intents" table',
  },
  {
    pattern: /updateTable\(\s*["']payment_intents["']\s*\)/,
    reason: 'writes the "payment_intents" table',
  },
  {
    pattern: /insertInto\(\s*["']payment_intents["']\s*\)/,
    reason: 'inserts into the "payment_intents" table',
  },
  { pattern: /from\s+["']\.\.\/routing\.js["']/, reason: "imports the dispatch routing module" },
  { pattern: /from\s+["']\.\.\/execution-events\.js["']/, reason: "imports execution-events machinery" },
  { pattern: /conversation_id/, reason: "references the OpenHands conversation id column" },
  { pattern: /from\s+["']\.\.\/planner\.js["']/, reason: "imports the planner LLM module" },
  { pattern: /generatePlannerOutput/, reason: "calls the planner LLM" },
];

test("routes/task-provenance.ts never references executions, payment_intents, the planner, or dispatch routing", () => {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    assert.ok(
      !pattern.test(source),
      `routes/task-provenance.ts must not ${reason} — creating a provenance-bound task must never ` +
        `be able to reach execution dispatch, conversation machinery, or settlement`,
    );
  }
});

test("routes/task-provenance.ts does not import routes/jobs.ts or routes/internal.ts", () => {
  assert.ok(
    !/from\s+["']\.\/jobs\.js["']/.test(source),
    "task-provenance routes must not import jobs.ts — the two surfaces must stay fully independent",
  );
  assert.ok(
    !/from\s+["']\.\/internal\.js["']/.test(source),
    "task-provenance routes must not import internal.ts",
  );
});

test("routes/task-provenance.ts only ever inserts a task at AWAITING_FUNDING, never QUEUED/RUNNING", () => {
  assert.ok(
    !/status:\s*["'](QUEUED|RUNNING|VERIFYING)["']/.test(source),
    "routes/task-provenance.ts must never write a task status beyond AWAITING_FUNDING — activation happens only " +
      "through the separately-hardened /fund transition",
  );
  assert.ok(
    /status:\s*["']AWAITING_FUNDING["']/.test(source),
    "expected the canonical task insert to set status: 'AWAITING_FUNDING'",
  );
});
