// Phase 4E.1 static invariant (mirrors the 4A/4B/4C no-execution-path tests):
// the funding route/service/provider sources must never reference the
// execution, claim, dispatch or QUEUED machinery, and must never touch
// payment_intents (historical legacy state) or the legacy escrow
// instructions. Only POST /fund in routes/jobs.ts may queue a task.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../src/", import.meta.url);
const FILES = [
  "routes/project-funding.ts",
  ...readdirSync(new URL("solana/", root)).map((f) => `solana/${f}`),
];

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /["'`]QUEUED["'`]/, reason: "references the QUEUED status" },
  { pattern: /\bexecutions\b/, reason: "references the executions table" },
  { pattern: /executions\/claim|dispatch/i, reason: "references claim/dispatch" },
  { pattern: /payment_intents|paymentIntents/, reason: "references the legacy payment_intents table" },
  { pattern: /conversation_id|agent-server|openhands/i, reason: "references OpenHands/conversation machinery" },
  { pattern: /\/fund\b/, reason: "references the activation route" },
  { pattern: /escrow/i, reason: "references escrow (4E.2 semantics)" },
  { pattern: /updateTable\(\s*["']tasks["']/, reason: "mutates the tasks table" },
];

test("funding sources never reference executions/QUEUED/payment_intents/escrow or mutate tasks", () => {
  for (const file of FILES) {
    const src = readFileSync(join(new URL(".", root).pathname.replace(/^\/([A-Za-z]:)/, "$1"), file), "utf8")
      // comments may legitimately mention the forbidden words
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const { pattern, reason } of FORBIDDEN) {
      assert.ok(!pattern.test(src), `${file} ${reason}`);
    }
  }
});

test("only routes/jobs.ts (the activation gate) writes QUEUED for funding", () => {
  const jobs = readFileSync(new URL("routes/jobs.ts", root), "utf8");
  assert.match(jobs, /project_funding_accounts/);
  assert.match(jobs, /FUNDED.*QUEUED|"QUEUED"/s);
  assert.ok(!jobs.includes("idempotency_key: `fund:${id}`"), "the stub fund payment intent is removed");
});
