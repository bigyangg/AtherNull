// Spike E: inserts ONE additional, distinctively-labeled real event into the
// SAME already-seeded execution (spike-c-full-shell-adapter/seed/seed-output.json's
// `executionId`) via the same zero-cost, zero-LLM, zero-Solana internal
// endpoint spikes C/D already used: POST /internal/executions/:id/events
// (apps/api/src/routes/internal.ts). This is the genuine data-freshness
// probe for Spike E — proving refresh actually reflects new data, not just
// that a button/reload exists.
//
// WORKER-LEASE NOTE (found while building this, not assumed): that endpoint
// requires the request's `workerId` to equal the execution's current
// `lease_owner` column (checked directly in internal.ts's handler) or it
// 409s. seed.ts's own seed-output.json does NOT record the random
// `worker-<uuid>` id it used at claim time — only executionId/taskId/etc are
// written there. Completing an execution does NOT clear `lease_owner`
// either (confirmed by reading internal.ts's `/complete` handler: it only
// updates `executions.status`/`ended_at`, never `lease_owner`). So this
// script looks the real `lease_owner` up with one read-only SELECT against
// the same local dev Postgres seed.ts already connects to directly (same
// bypass pattern seed.ts uses for its emailVerified/agent_profiles writes,
// here used for a read instead of a write) rather than guessing a workerId
// or hardcoding one that would silently go stale.
//
// Each run generates a FRESH, uniquely-labeled MessageEvent (never reuses a
// previous run's text) so this script can be invoked multiple times — once
// to self-verify, once per smoke test — with each invocation's distinctive
// text being something that is verifiably absent from the UI until THAT
// invocation's own refresh. The exact text + event id this run inserted is
// written to seed-followup-event-output.json so a Playwright script that
// just spawned this process synchronously knows exactly what to assert for,
// instead of re-deriving or guessing it.
import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_dev";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
const API_BASE = process.env.API_BASE ?? "http://localhost:3001";

if (!INTERNAL_API_TOKEN) {
  console.error(
    "INTERNAL_API_TOKEN is not set. Run with the same value apps/api/.env's " +
      "dev server was started with, e.g.:\n" +
      "  INTERNAL_API_TOKEN=<value from apps/api/.env> node seed-followup-event.mjs [label]",
  );
  process.exit(1);
}

const seedOutputPath = path.resolve(
  __dirname,
  "..",
  "spike-c-full-shell-adapter",
  "seed",
  "seed-output.json",
);
const seedOutput = JSON.parse(readFileSync(seedOutputPath, "utf8"));
const executionId = seedOutput.executionId;

const label = process.argv[2] ?? randomUUID().slice(0, 8);
const distinctiveText = `[Spike-E followup ${label}] Genuinely new event inserted at ${new Date().toISOString()} — proof this is a live refresh, not a cached render.`;

async function main() {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();

  const execRow = await pg.query(
    `select lease_owner, status from executions where id = $1`,
    [executionId],
  );
  if (execRow.rows.length === 0) {
    await pg.end();
    throw new Error(
      `No execution found for id ${executionId} — has the local dev DB been reset since Spike C's seed ran?`,
    );
  }
  const workerId = execRow.rows[0].lease_owner;
  if (!workerId) {
    await pg.end();
    throw new Error(
      `execution ${executionId} has no lease_owner recorded — cannot satisfy internal.ts's workerId===lease_owner check.`,
    );
  }

  const countBeforeRes = await pg.query(
    `select count(*)::int as count from execution_events where execution_id = $1`,
    [executionId],
  );
  const countBefore = countBeforeRes.rows[0].count;

  const eventId = randomUUID();
  const res = await fetch(`${API_BASE}/internal/executions/${executionId}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INTERNAL_API_TOKEN}`,
    },
    body: JSON.stringify({
      workerId,
      events: [
        {
          id: eventId,
          kind: "MessageEvent",
          occurredAt: new Date().toISOString(),
          payload: {
            source: "agent",
            llm_message: {
              role: "assistant",
              content: [{ type: "text", text: distinctiveText }],
            },
            activated_skills: [],
            extended_content: [],
          },
        },
      ],
    }),
  });

  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    await pg.end();
    throw new Error(`POST /internal/executions/${executionId}/events failed: ${res.status} ${body}`);
  }

  const countAfterRes = await pg.query(
    `select count(*)::int as count from execution_events where execution_id = $1`,
    [executionId],
  );
  const countAfter = countAfterRes.rows[0].count;
  const insertedRes = await pg.query(
    `select id, kind, occurred_at from execution_events where id = $1`,
    [eventId],
  );

  await pg.end();

  const landed = insertedRes.rows.length === 1 && countAfter === countBefore + 1;
  if (!landed) {
    throw new Error(
      `Event did not land as expected: countBefore=${countBefore}, countAfter=${countAfter}, insertedRowFound=${insertedRes.rows.length === 1}`,
    );
  }

  const output = {
    executionId,
    eventId,
    label,
    distinctiveText,
    countBefore,
    countAfter,
    insertedAt: new Date().toISOString(),
  };

  writeFileSync(
    path.resolve(__dirname, "seed-followup-event-output.json"),
    JSON.stringify(output, null, 2),
  );

  console.log(
    `[seed-followup] inserted event ${eventId} (label=${label}); event count ${countBefore} -> ${countAfter}`,
  );
  console.log(`[seed-followup] distinctiveText: ${distinctiveText}`);
}

main().catch((err) => {
  console.error("[seed-followup] FAILED:", err);
  process.exit(1);
});
