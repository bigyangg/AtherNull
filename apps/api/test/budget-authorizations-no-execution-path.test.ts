// Static source test — no app boot, no DB — for the hard invariant that
// routes/budget-authorizations.ts can never reach task/execution dispatch or
// settlement. Complements (does not replace) the runtime check in
// budget-authorizations-lifecycle.test.ts. Mirrors
// apps/api/test/estimates-no-execution-path.test.ts exactly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeFilePath = path.join(here, "..", "src", "routes", "budget-authorizations.ts");
const source = readFileSync(routeFilePath, "utf8");

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /selectFrom\(\s*["']tasks["']\s*\)/, reason: 'reads the "tasks" table' },
  { pattern: /updateTable\(\s*["']tasks["']\s*\)/, reason: 'writes the "tasks" table' },
  { pattern: /insertInto\(\s*["']tasks["']\s*\)/, reason: 'inserts into the "tasks" table' },
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
  { pattern: /\/fund\b/, reason: "references the /fund endpoint path" },
  { pattern: /from\s+["']\.\.\/routing\.js["']/, reason: "imports the dispatch routing module" },
  { pattern: /from\s+["']\.\.\/execution-events\.js["']/, reason: "imports execution-events machinery" },
  { pattern: /conversation_id/, reason: "references the OpenHands conversation id column" },
  { pattern: /from\s+["']\.\.\/planner\.js["']/, reason: "imports the planner LLM module" },
  { pattern: /generatePlannerOutput/, reason: "calls the planner LLM" },
];

test("routes/budget-authorizations.ts never references tasks, executions, payment_intents, /fund, or the planner", () => {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    assert.ok(
      !pattern.test(source),
      `routes/budget-authorizations.ts must not ${reason} — authorizing a budget must never ` +
        `be able to reach task/execution dispatch, settlement, or re-ask the model for money`,
    );
  }
});

test("routes/budget-authorizations.ts does not import routes/jobs.ts or routes/internal.ts", () => {
  assert.ok(
    !/from\s+["']\.\/jobs\.js["']/.test(source),
    "budget-authorizations routes must not import jobs.ts — the two surfaces must stay fully independent",
  );
  assert.ok(
    !/from\s+["']\.\/internal\.js["']/.test(source),
    "budget-authorizations routes must not import internal.ts",
  );
});
