// Phase 4E.2 — acceptance-triggered settlement and rejection/failure refund
// of a devnet ProjectFunding account. Integration tests against a real
// Postgres via Fastify inject(); the REAL settlement service runs, only the
// RPC transport + program state transitions are doubled (fake-chain.ts).
//
// Tasks here are moved to AWAITING_ACCEPTANCE / FAILED directly in the DB
// after funding, never through QUEUED, so nothing enters the shared claim
// queue (see job-lifecycle.test.ts's shared-queue rule).
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-not-for-real-use-00000000000000000000";
process.env.BETTER_AUTH_URL ??= "http://localhost:3001";
process.env.WEB_APP_URL ??= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
process.env.AUTH_TEST_RATE_LIMIT_MAX ??= "50";
process.env.INTERNAL_API_TOKEN ??= "test-internal-token-not-for-real-use";
process.env.SOLANA_NETWORK = "devnet";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { SolanaRpcError } = await import("../src/solana/errors.js");
const { setFundingRuntimeForTests } = await import("../src/solana/runtime.js");
const { FakeChain, makeRuntime, SETTLEMENT_RECIPIENT } = await import("./support/fake-chain.js");
const { createAwaitingFundingTask } = await import("./support/app-fixtures.js");

const PROGRAM_ID = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");
const M = 1_000_000n;
const REQUIRED = 50n * M;

let app: FastifyInstance;
let chain: InstanceType<typeof FakeChain>;
let authority: Keypair;

before(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

after(async () => {
  setFundingRuntimeForTests(null);
  await app.close();
});

beforeEach(() => {
  chain = new FakeChain(PROGRAM_ID);
  authority = Keypair.generate();
  setFundingRuntimeForTests(makeRuntime(chain, authority, REQUIRED));
});

type T = Awaited<ReturnType<typeof createAwaitingFundingTask>>;

const post = (t: T, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie: t.jar.header }, payload: payload as object | undefined });
const get = (t: T, url: string) => app.inject({ method: "GET", url, headers: { cookie: t.jar.header } });

interface Progress {
  taskStatus: string;
  settlement: {
    kind: string;
    status: string;
    releaseLamports: string;
    refundLamports: string;
    recipientWallet: string | null;
    signature: string | null;
  } | null;
}

/** A task with a verified, finalized devnet deposit, parked at `status` (never via QUEUED). */
async function fundedTaskAt(status: "AWAITING_ACCEPTANCE" | "FAILED", depositLamports = 60n * M) {
  const t = await createAwaitingFundingTask(app);
  assert.equal((await post(t, `/v1/jobs/${t.taskId}/funding`)).statusCode, 201);
  const wallet = Keypair.generate();
  const prep = await post(t, `/v1/jobs/${t.taskId}/funding/prepare`, {
    customerWallet: wallet.publicKey.toBase58(),
    amountLamports: depositLamports.toString(),
  });
  assert.equal(prep.statusCode, 200, prep.body);
  const tx = (JSON.parse(prep.body) as { transaction: { base64: string } }).transaction;
  const signature = chain.signAndSubmit(tx.base64, wallet);
  const verified = await post(t, `/v1/jobs/${t.taskId}/funding/verify`, { signature });
  assert.equal(verified.statusCode, 200, verified.body);
  await db.updateTable("tasks").set({ status }).where("id", "=", t.taskId).execute();
  const pda = (await db.selectFrom("project_funding_accounts").select("onchain_account").where("task_id", "=", t.taskId).executeTakeFirstOrThrow()).onchain_account;
  return { t, wallet, pda };
}

async function statusOf(taskId: string) {
  return (await db.selectFrom("tasks").select("status").where("id", "=", taskId).executeTakeFirstOrThrow()).status;
}

async function settlementOf(taskId: string) {
  return db.selectFrom("project_funding_settlements").selectAll().where("task_id", "=", taskId).executeTakeFirst();
}

const sends = () => chain.calls.filter((c) => c === "sendRawTransaction").length;

describe("accept settles on chain", () => {
  test("releases the requirement to the provider, returns over-funding to the customer, closes the account, reaches SETTLED", async () => {
    const { t, wallet, pda } = await fundedTaskAt("AWAITING_ACCEPTANCE", 60n * M);

    const accepted = await post(t, `/v1/jobs/${t.taskId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((JSON.parse(accepted.body) as { status: string }).status, "SETTLED");

    assert.equal(chain.payouts.get(SETTLEMENT_RECIPIENT.toBase58()), 50n * M);
    assert.equal(chain.payouts.get(wallet.publicKey.toBase58()), 10n * M);
    assert.equal(chain.peek(pda), null, "account closed");

    const row = await settlementOf(t.taskId);
    assert.equal(row?.kind, "SETTLE");
    assert.equal(row?.status, "FINALIZED");
    assert.equal(row?.release_amount_base_units, String(50n * M));
    assert.equal(row?.refund_amount_base_units, String(10n * M));
    assert.equal(row?.recipient_wallet, SETTLEMENT_RECIPIENT.toBase58());

    // The funding view now carries the settlement for the UI.
    const view = JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as { settlement: Progress["settlement"] };
    assert.equal(view.settlement?.status, "FINALIZED");
    assert.equal(view.settlement?.signature, row?.signature);

    // No legacy stub intent for an on-chain settlement.
    const intents = await db.selectFrom("payment_intents").selectAll().where("job_id", "=", t.taskId).execute();
    assert.equal(intents.length, 0);

    // A second accept is refused and pays nothing.
    const sendsBefore = sends();
    const again = await post(t, `/v1/jobs/${t.taskId}/accept`);
    assert.equal(again.statusCode, 409);
    assert.equal(sends(), sendsBefore);
  });

  test("an under-funded deposit is released in full (never more than deposited)", async () => {
    const { t, wallet } = await fundedTaskAt("AWAITING_ACCEPTANCE", 30n * M);
    const accepted = await post(t, `/v1/jobs/${t.taskId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(chain.payouts.get(SETTLEMENT_RECIPIENT.toBase58()), 30n * M);
    assert.equal(chain.payouts.get(wallet.publicKey.toBase58()) ?? 0n, 0n);
  });

  test("stays SETTLING until the payout is finalized; verify then completes it without re-sending", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    chain.holdAtConfirmed = true;

    const accepted = await post(t, `/v1/jobs/${t.taskId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((JSON.parse(accepted.body) as { status: string }).status, "SETTLING");
    const row = await settlementOf(t.taskId);
    assert.equal(row?.status, "SUBMITTED");
    assert.ok(row?.signature);
    const sendsAfterAccept = sends();

    // Still only confirmed: verify reports progress, changes nothing, sends nothing.
    const pending = JSON.parse((await post(t, `/v1/jobs/${t.taskId}/settlement/verify`)).body) as Progress;
    assert.equal(pending.taskStatus, "SETTLING");
    assert.equal(pending.settlement?.status, "SUBMITTED");
    assert.equal(sends(), sendsAfterAccept);

    chain.finalize(row!.signature!);
    const done = JSON.parse((await post(t, `/v1/jobs/${t.taskId}/settlement/verify`)).body) as Progress;
    assert.equal(done.taskStatus, "SETTLED");
    assert.equal(done.settlement?.status, "FINALIZED");
    assert.equal(await statusOf(t.taskId), "SETTLED");
    assert.equal(sends(), sendsAfterAccept, "verify never re-sends a live attempt");

    // Idempotent afterwards.
    const repeat = JSON.parse((await post(t, `/v1/jobs/${t.taskId}/settlement/verify`)).body) as Progress;
    assert.equal(repeat.taskStatus, "SETTLED");
  });

  test("an RPC outage after the decision leaves SETTLING; verify resumes and pays exactly once", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    chain.outage = new SolanaRpcError("SERVER_ERROR", "simulated 503", true);

    const accepted = await post(t, `/v1/jobs/${t.taskId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal((JSON.parse(accepted.body) as { status: string }).status, "SETTLING");
    assert.equal((await settlementOf(t.taskId))?.status, "PENDING");

    const during = await post(t, `/v1/jobs/${t.taskId}/settlement/verify`);
    assert.equal(during.statusCode, 503, "fail closed while the chain is unreachable");
    assert.equal(await statusOf(t.taskId), "SETTLING");

    chain.outage = null;
    const done = JSON.parse((await post(t, `/v1/jobs/${t.taskId}/settlement/verify`)).body) as Progress;
    assert.equal(done.taskStatus, "SETTLED");
    assert.equal(chain.payouts.get(SETTLEMENT_RECIPIENT.toBase58()), 50n * M);
  });

  test("a payout that landed but whose signature was lost is recovered from chain history, not re-sent", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    chain.holdAtConfirmed = true;
    await post(t, `/v1/jobs/${t.taskId}/accept`);
    const sent = await settlementOf(t.taskId);
    chain.finalize(sent!.signature!);
    // Simulate a crash between sending and persisting the signature.
    await db
      .updateTable("project_funding_settlements")
      .set({ signature: null, sent_at: null, status: "PENDING" })
      .where("id", "=", sent!.id)
      .execute();

    const sendsBefore = sends();
    const done = JSON.parse((await post(t, `/v1/jobs/${t.taskId}/settlement/verify`)).body) as Progress;
    assert.equal(done.taskStatus, "SETTLED");
    assert.equal(done.settlement?.signature, sent!.signature);
    assert.equal(sends(), sendsBefore);
  });
});

describe("reject and failure refund on chain", () => {
  test("reject returns the full deposit to the customer and reaches REFUNDED", async () => {
    const { t, wallet, pda } = await fundedTaskAt("AWAITING_ACCEPTANCE", 60n * M);
    const rejected = await post(t, `/v1/jobs/${t.taskId}/reject`, { reason: "not what I asked for" });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal((JSON.parse(rejected.body) as { status: string }).status, "REFUNDED");
    assert.equal(chain.payouts.get(wallet.publicKey.toBase58()), 60n * M);
    assert.equal(chain.payouts.get(SETTLEMENT_RECIPIENT.toBase58()) ?? 0n, 0n);
    assert.equal(chain.peek(pda), null);
    const row = await settlementOf(t.taskId);
    assert.equal(row?.kind, "REFUND");
    assert.equal(row?.recipient_wallet, null);
  });

  test("a failed funded build can be refunded; one without a deposit cannot", async () => {
    const { t, wallet } = await fundedTaskAt("FAILED", 50n * M);
    const refunded = await post(t, `/v1/jobs/${t.taskId}/refund`);
    assert.equal(refunded.statusCode, 200, refunded.body);
    assert.equal((JSON.parse(refunded.body) as { status: string }).status, "REFUNDED");
    assert.equal(chain.payouts.get(wallet.publicKey.toBase58()), 50n * M);

    const unfunded = await createAwaitingFundingTask(app);
    await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", unfunded.taskId).execute();
    const refused = await post(unfunded, `/v1/jobs/${unfunded.taskId}/refund`);
    assert.equal(refused.statusCode, 409, refused.body);
  });

  test("refund is only for failed/cancelled builds", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    const refused = await post(t, `/v1/jobs/${t.taskId}/refund`);
    assert.equal(refused.statusCode, 409);
    assert.equal(await settlementOf(t.taskId), undefined);
  });
});

describe("tenancy and database integrity", () => {
  test("another organization cannot accept, refund or drive a settlement", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    const other = await createAwaitingFundingTask(app);
    assert.equal((await post(other, `/v1/jobs/${t.taskId}/accept`)).statusCode, 404);
    assert.equal((await post(other, `/v1/jobs/${t.taskId}/settlement/verify`)).statusCode, 404);
    assert.equal(await settlementOf(t.taskId), undefined);
    assert.equal(await statusOf(t.taskId), "AWAITING_ACCEPTANCE");
  });

  test("the settlement decision is immutable and a finalized row is frozen", async () => {
    const { t } = await fundedTaskAt("AWAITING_ACCEPTANCE");
    await post(t, `/v1/jobs/${t.taskId}/accept`);
    const row = (await settlementOf(t.taskId))!;
    await assert.rejects(
      db.updateTable("project_funding_settlements").set({ release_amount_base_units: "1" }).where("id", "=", row.id).execute(),
    );
    await assert.rejects(
      db.updateTable("project_funding_settlements").set({ signature: null, sent_at: null, status: "PENDING", finalized_at: null, finalized_slot: null }).where("id", "=", row.id).execute(),
    );
    await assert.rejects(db.deleteFrom("project_funding_settlements").where("id", "=", row.id).execute());
  });
});
