// Static source test — no app boot, no DB — for the hard invariant that
// routes/estimates.ts can never reach task/execution dispatch. This
// complements (does not replace) the runtime check in
// estimates-lifecycle.test.ts ("approving an estimate never touches
// tasks/executions"): this test would fail the instant anyone adds so much
// as a `db.selectFrom("tasks")` to this file, even before it's ever
// exercised at runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const routeFilePath = path.join(here, "..", "src", "routes", "estimates.ts");
const source = readFileSync(routeFilePath, "utf8");

// Patterns that would indicate this file reaches into task/execution
// dispatch — the one thing this entire phase must never do (see the task's
// own header comment and the design doc's "hard security/business
// invariant": nothing reaches OpenHands execution except a task reaching
// QUEUED via the privileged POST /v1/jobs/:id/fund endpoint).
const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /selectFrom\(\s*["']tasks["']\s*\)/, reason: 'reads the "tasks" table' },
  { pattern: /updateTable\(\s*["']tasks["']\s*\)/, reason: 'writes the "tasks" table' },
  { pattern: /insertInto\(\s*["']tasks["']\s*\)/, reason: 'inserts into the "tasks" table' },
  { pattern: /selectFrom\(\s*["']executions["']\s*\)/, reason: 'reads the "executions" table' },
  { pattern: /updateTable\(\s*["']executions["']\s*\)/, reason: 'writes the "executions" table' },
  { pattern: /insertInto\(\s*["']executions["']\s*\)/, reason: 'inserts into the "executions" table' },
  { pattern: /\/fund\b/, reason: "references the /fund endpoint path" },
  { pattern: /from\s+["']\.\.\/routing\.js["']/, reason: "imports the dispatch routing module" },
  { pattern: /from\s+["']\.\.\/execution-events\.js["']/, reason: "imports execution-events machinery" },
  { pattern: /conversation_id/, reason: "references the OpenHands conversation id column" },
];

test("routes/estimates.ts never references tasks, executions, or /fund", () => {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    assert.ok(
      !pattern.test(source),
      `routes/estimates.ts must not ${reason} — estimate generation/revision/approval must ` +
        `never be able to reach task/execution dispatch`,
    );
  }
});

test("routes/estimates.ts does not import routes/jobs.ts", () => {
  assert.ok(
    !/from\s+["']\.\/jobs\.js["']/.test(source),
    "estimates routes must not import jobs.ts — the two surfaces must stay fully independent",
  );
});
