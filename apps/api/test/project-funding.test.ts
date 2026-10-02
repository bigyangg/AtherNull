// Phase 4E.1 — Solana devnet project funding + activation gate. Integration
// tests against a real Postgres database via Fastify inject(). The REAL
// funding/verification service runs; only the RPC transport + the on-chain
// program's state transitions are doubled (test/support/fake-chain.ts).
//
// Shared-queue rule (see job-lifecycle.test.ts's header): any task this file
// activates to QUEUED is neutralized immediately after its assertions so it
// never sits in the global claim FIFO for another file's claim coverage.
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

import { computeBindingHash, deriveProjectFundingPda, toHex, buildDepositProjectFundingIx } from "@athernull/solana-client";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { FastifyInstance } from "fastify";

const { buildApp } = await import("../src/app.js");
const { db } = await import("../src/db.js");
const { SolanaRpcError } = await import("../src/solana/errors.js");
const { setFundingRuntimeForTests } = await import("../src/solana/runtime.js");
const { FakeChain, makeRuntime } = await import("./support/fake-chain.js");
const { countExecutionsForOrg, createAwaitingFundingTask } = await import("./support/app-fixtures.js");

const PROGRAM_ID = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");
const SECRET_MARKER = "SECRET-TEST-KEY";
const M = 1_000_000n;

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
  setFundingRuntimeForTests(makeRuntime(chain, authority, 50n * M));
});

type T = Awaited<ReturnType<typeof createAwaitingFundingTask>>;

const post = (t: T, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie: t.jar.header }, payload: payload as object | undefined });
const get = (t: T, url: string) => app.inject({ method: "GET", url, headers: { cookie: t.jar.header } });

const createFunding = (t: T) => post(t, `/v1/jobs/${t.taskId}/funding`);
const prepare = (t: T, wallet: Keypair, amount?: bigint) =>
  post(t, `/v1/jobs/${t.taskId}/funding/prepare`, {
    customerWallet: wallet.publicKey.toBase58(),
    ...(amount !== undefined ? { amountLamports: amount.toString() } : {}),
  });
const verify = (t: T, signature?: string) => post(t, `/v1/jobs/${t.taskId}/funding/verify`, signature ? { signature } : {});
const activate = (t: T) => post(t, `/v1/jobs/${t.taskId}/fund`);

interface FundingBody {
  id: string;
  status: string;
  requiredLamports: string;
  confirmedLamports: string;
  customerWallet: string | null;
  initialized: boolean;
  onchainAccount: string;
  deposits: { signature: string; amountLamports: string }[];
}

async function newFundedSetup() {
  const t = await createAwaitingFundingTask(app);
  const created = await createFunding(t);
  assert.equal(created.statusCode, 201, created.body);
  const wallet = Keypair.generate();
  return { t, wallet };
}

/** prepare -> wallet signs -> chain accepts. Returns the signature. */
async function depositVia(t: T, wallet: Keypair, amount: bigint, opts: { fail?: boolean } = {}): Promise<string> {
  const res = await prepare(t, wallet, amount);
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body) as { state: string; transaction: { base64: string; amountLamports: string } | null };
  assert.equal(body.state, "READY");
  assert.equal(body.transaction!.amountLamports, amount.toString());
  return chain.signAndSubmit(body.transaction!.base64, wallet, opts);
}

async function neutralize(taskId: string) {
  await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", taskId).execute();
}

async function taskStatus(taskId: string) {
  return (await db.selectFrom("tasks").select(["status", "version"]).where("id", "=", taskId).executeTakeFirstOrThrow());
}

describe("funding account: provenance, tenancy, idempotency, DB integrity", () => {
  test("create derives everything server-side, binds the exact task, snapshots DEMO_FIXED, and is idempotent", async () => {
    const t = await createAwaitingFundingTask(app);
    const executionsBefore = await countExecutionsForOrg(t.organizationId);

    const created = await createFunding(t);
    assert.equal(created.statusCode, 201, created.body);
    const body = JSON.parse(created.body) as FundingBody & { network: string; asset: string; requirementSource: string };
    assert.equal(body.network, "devnet");
    assert.equal(body.asset, "DEVNET_SOL");
    assert.equal(body.requirementSource, "DEMO_FIXED");
    assert.equal(body.requiredLamports, "50000000");
    assert.equal(body.confirmedLamports, "0");
    assert.equal(body.status, "AWAITING_FUNDS");
    assert.equal(body.customerWallet, null);
    assert.equal(body.initialized, false);

    const row = await db.selectFrom("project_funding_accounts").selectAll().where("task_id", "=", t.taskId).executeTakeFirstOrThrow();
    assert.equal(row.organization_id, t.organizationId);
    assert.equal(row.project_id, t.projectId);
    assert.equal(row.budget_authorization_id, t.budgetAuthorizationId);
    assert.equal(row.network, "devnet");
    assert.equal(row.rpc_provider, "helius");
    const hash = computeBindingHash({
      organizationId: t.organizationId,
      projectId: t.projectId,
      taskId: t.taskId,
      budgetAuthorizationId: t.budgetAuthorizationId,
    });
    assert.equal(Buffer.from(row.binding_hash).toString("hex"), toHex(hash));
    assert.equal(row.onchain_account, deriveProjectFundingPda(PROGRAM_ID, hash)[0].toBase58());
    // The requirement is NOT derived from the budget authorization amount.
    assert.notEqual(row.required_amount_base_units, "1000");

    const again = await createFunding(t);
    assert.equal(again.statusCode, 200);
    assert.equal((JSON.parse(again.body) as FundingBody).id, body.id);
    const rows = await db.selectFrom("project_funding_accounts").select("id").where("task_id", "=", t.taskId).execute();
    assert.equal(rows.length, 1);

    assert.equal(await countExecutionsForOrg(t.organizationId), executionsBefore, "create must cause zero executions");
    assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");
    assert.equal(chain.calls.length, 0, "creating the account needs no chain access");
  });

  test("another organization cannot read or create funding for this task", async () => {
    const a = await createAwaitingFundingTask(app);
    const b = await createAwaitingFundingTask(app);
    assert.equal((await post(b, `/v1/jobs/${a.taskId}/funding`)).statusCode, 404);
    assert.equal((await get(b, `/v1/jobs/${a.taskId}/funding`)).statusCode, 404);
    await createFunding(a);
    assert.equal((await get(b, `/v1/jobs/${a.taskId}/funding`)).statusCode, 404);
    assert.equal((await get(a, `/v1/jobs/${a.taskId}/funding`)).statusCode, 200);
  });

  test("the database itself enforces tenant/provenance/network/asset/uniqueness", async () => {
    const a = await createAwaitingFundingTask(app);
    const b = await createAwaitingFundingTask(app);
    await createFunding(a);
    const aRow = await db.selectFrom("project_funding_accounts").selectAll().where("task_id", "=", a.taskId).executeTakeFirstOrThrow();

    const base = {
      organization_id: b.organizationId,
      project_id: b.projectId,
      task_id: b.taskId,
      budget_authorization_id: b.budgetAuthorizationId,
      network: "devnet",
      rpc_provider: "helius",
      asset_type: "DEVNET_SOL",
      program_id: PROGRAM_ID.toBase58(),
      onchain_account: Keypair.generate().publicKey.toBase58(),
      binding_hash: Buffer.from(Keypair.generate().publicKey.toBytes()),
      requirement_source: "DEMO_FIXED",
      required_amount_base_units: "50000000",
      created_by: b.userId,
    };
    const rejects = async (over: Record<string, unknown>) => {
      await assert.rejects(db.insertInto("project_funding_accounts").values({ ...base, ...over } as never).execute());
    };
    await rejects({ budget_authorization_id: a.budgetAuthorizationId }); // not this task's authorization
    await rejects({ organization_id: a.organizationId }); // wrong tenant for the task
    await rejects({ project_id: a.projectId });
    await rejects({ network: "mainnet-beta" });
    await rejects({ network: "testnet" });
    await rejects({ asset_type: "SOL" });
    await rejects({ rpc_provider: "other" });
    await rejects({ requirement_source: "BUDGET" });
    await rejects({ required_amount_base_units: "0" });
    await rejects({ binding_hash: Buffer.alloc(31) });
    await rejects({ task_id: a.taskId, budget_authorization_id: a.budgetAuthorizationId, organization_id: a.organizationId, project_id: a.projectId }); // one per task
    await rejects({ binding_hash: aRow.binding_hash }); // unique binding

    // Status is a pure function of amounts.
    await assert.rejects(
      db.updateTable("project_funding_accounts").set({ status: "FUNDED" }).where("id", "=", aRow.id).execute(),
    );
    // Identity columns are immutable.
    await assert.rejects(
      db.updateTable("project_funding_accounts").set({ onchain_account: Keypair.generate().publicKey.toBase58() }).where("id", "=", aRow.id).execute(),
    );
    // Lamports are integers only (no floats in a bigint column).
    await assert.rejects(
      db.updateTable("project_funding_accounts").set({ confirmed_amount_base_units: "1.5" }).where("id", "=", aRow.id).execute(),
    );
  });

  test("a non-AWAITING_FUNDING task cannot get a funding account", async () => {
    const t = await createAwaitingFundingTask(app);
    await db.updateTable("tasks").set({ status: "CANCELLED" }).where("id", "=", t.taskId).execute();
    assert.equal((await createFunding(t)).statusCode, 409);
  });
});

describe("customer wallet binding + on-chain initialize", () => {
  test("binds once, idempotent for the same wallet, 409 for a different wallet, immutable in the DB", async () => {
    const { t, wallet } = await newFundedSetup();
    const first = await prepare(t, wallet);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((JSON.parse(first.body) as { funding: FundingBody }).funding.customerWallet, wallet.publicKey.toBase58());

    const second = await prepare(t, wallet);
    assert.equal(second.statusCode, 200);

    const other = await prepare(t, Keypair.generate());
    assert.equal(other.statusCode, 409);
    assert.match(other.body, /WALLET_CONFLICT/);

    await assert.rejects(
      db.updateTable("project_funding_accounts").set({ customer_wallet: Keypair.generate().publicKey.toBase58() }).where("task_id", "=", t.taskId).execute(),
    );
    const initCount = chain.calls.filter((c) => c === "sendRawTransaction").length;
    assert.equal(initCount, 1, "the on-chain account is initialized exactly once");
    assert.ok(chain.peek((await db.selectFrom("project_funding_accounts").select("onchain_account").where("task_id", "=", t.taskId).executeTakeFirstOrThrow()).onchain_account));
  });

  test("concurrent prepare with different wallets: exactly one wins, on-chain customer is the winner", async () => {
    const { t } = await newFundedSetup();
    const w1 = Keypair.generate();
    const w2 = Keypair.generate();
    const [r1, r2] = await Promise.all([prepare(t, w1), prepare(t, w2)]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    assert.deepEqual(statuses, [200, 409], `${r1.body} / ${r2.body}`);
    const winner = r1.statusCode === 200 ? w1 : w2;
    const row = await db.selectFrom("project_funding_accounts").selectAll().where("task_id", "=", t.taskId).executeTakeFirstOrThrow();
    assert.equal(row.customer_wallet, winner.publicKey.toBase58());
    // Only one initialize was ever sent, for the winning customer.
    assert.equal(chain.calls.filter((c) => c === "sendRawTransaction").length, 1);
  });

  test("concurrent prepare with the SAME wallet never double-initializes", async () => {
    const { t, wallet } = await newFundedSetup();
    const results = await Promise.all([prepare(t, wallet), prepare(t, wallet), prepare(t, wallet)]);
    for (const r of results) assert.equal(r.statusCode, 200, r.body);
    assert.equal(chain.calls.filter((c) => c === "sendRawTransaction").length, 1);
  });

  test("an off-curve (non-wallet) address is rejected", async () => {
    const { t } = await newFundedSetup();
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("x")], PROGRAM_ID);
    const res = await post(t, `/v1/jobs/${t.taskId}/funding/prepare`, { customerWallet: pda.toBase58() });
    assert.equal(res.statusCode, 409);
  });

  test("prepare returns an unsigned deposit transaction whose instruction is exactly the requested deposit", async () => {
    const { t, wallet } = await newFundedSetup();
    const res = await prepare(t, wallet, 20n * M);
    const body = JSON.parse(res.body) as { transaction: { base64: string } };
    const tx = Transaction.from(Buffer.from(body.transaction.base64, "base64"));
    assert.equal(tx.feePayer!.toBase58(), wallet.publicKey.toBase58());
    assert.equal(tx.instructions.length, 1);
    assert.equal(tx.signatures.every((s) => s.signature === null), true, "prepare never signs for the user");
    const expected = buildDepositProjectFundingIx({
      programId: PROGRAM_ID,
      customer: wallet.publicKey,
      projectFunding: new PublicKey((JSON.parse(res.body) as { funding: FundingBody }).funding.onchainAccount),
      amount: 20n * M,
    });
    assert.deepEqual(Buffer.from(tx.instructions[0]!.data), Buffer.from(expected.data));
  });

  test("default deposit amount is the remaining requirement; bad amounts are rejected", async () => {
    const { t, wallet } = await newFundedSetup();
    const res = await prepare(t, wallet);
    assert.equal((JSON.parse(res.body) as { transaction: { amountLamports: string } }).transaction.amountLamports, "50000000");
    const tooBig = await post(t, `/v1/jobs/${t.taskId}/funding/prepare`, { customerWallet: wallet.publicKey.toBase58(), amountLamports: "2000000000" });
    assert.equal(tooBig.statusCode, 400);
    const bad = await post(t, `/v1/jobs/${t.taskId}/funding/prepare`, { customerWallet: wallet.publicKey.toBase58(), amountLamports: "1.5" });
    assert.equal(bad.statusCode, 400);
  });
});

describe("deposit verification: finalized-only, instruction-decoded credit", () => {
  test("partial -> multiple -> funded; duplicate signature idempotent; only then does activation work; zero executions throughout", async () => {
    const { t, wallet } = await newFundedSetup();
    const exec0 = await countExecutionsForOrg(t.organizationId);

    const s1 = await depositVia(t, wallet, 20n * M);
    const v1 = JSON.parse((await verify(t, s1)).body) as { funding: FundingBody; signature: { outcome: string } };
    assert.equal(v1.signature.outcome, "CREDITED");
    assert.equal(v1.funding.status, "PARTIALLY_FUNDED");
    assert.equal(v1.funding.confirmedLamports, "20000000");

    // Partial funding blocks activation.
    const blocked = await activate(t);
    assert.equal(blocked.statusCode, 409);
    assert.match(blocked.body, /NOT_FUNDED/);
    assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");

    const s2 = await depositVia(t, wallet, 15n * M);
    const s3 = await depositVia(t, wallet, 15n * M);
    await verify(t, s2);
    const v3 = JSON.parse((await verify(t, s3)).body) as { funding: FundingBody };
    assert.equal(v3.funding.status, "FUNDED");
    assert.equal(v3.funding.confirmedLamports, "50000000");
    assert.equal(v3.funding.deposits.length, 3);

    // Re-verifying the same signature cannot double-credit.
    const dup = JSON.parse((await verify(t, s1)).body) as { funding: FundingBody; signature: { outcome: string } };
    assert.equal(dup.signature.outcome, "ALREADY_CREDITED");
    assert.equal(dup.funding.confirmedLamports, "50000000");
    assert.equal(dup.funding.deposits.length, 3);

    // Funding verification created no execution; the task is still not executable.
    assert.equal(await countExecutionsForOrg(t.organizationId), exec0);
    assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");

    const ok = await activate(t);
    assert.equal(ok.statusCode, 200, ok.body);
    const after = await taskStatus(t.taskId);
    assert.equal(after.status, "QUEUED");
    // Activation itself creates no execution row (a claim does), and writes no payment_intents.
    assert.equal(await countExecutionsForOrg(t.organizationId), exec0);
    const intents = await db.selectFrom("payment_intents").selectAll().where("job_id", "=", t.taskId).execute();
    assert.equal(intents.length, 0);
    await neutralize(t.taskId);
  });

  test("exact funding in one deposit permits activation", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 50n * M);
    await verify(t, sig);
    const res = await activate(t);
    assert.equal(res.statusCode, 200, res.body);
    await neutralize(t.taskId);
  });

  test("overfunding preserves the actual amount and permits activation", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 80n * M);
    const v = JSON.parse((await verify(t, sig)).body) as { funding: FundingBody };
    assert.equal(v.funding.status, "FUNDED");
    assert.equal(v.funding.confirmedLamports, "80000000");
    assert.equal(v.funding.requiredLamports, "50000000");
    assert.equal((await activate(t)).statusCode, 200);
    await neutralize(t.taskId);
  });

  test("confirmed-but-not-finalized is NOT credited; finalized is", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet, 50n * M); // initialize first (finalized immediately)
    chain.holdAtConfirmed = true;
    const sig = await depositVia(t, wallet, 50n * M);
    const pending = JSON.parse((await verify(t, sig)).body) as { funding: FundingBody; signature: { outcome: string; observedCommitment: string } };
    assert.equal(pending.signature.outcome, "PENDING");
    assert.equal(pending.signature.observedCommitment, "confirmed");
    assert.equal(pending.funding.confirmedLamports, "0");
    assert.equal(pending.funding.status, "AWAITING_FUNDS");
    assert.equal((await activate(t)).statusCode, 409);

    chain.finalize(sig);
    const done = JSON.parse((await verify(t, sig)).body) as { funding: FundingBody; signature: { outcome: string } };
    assert.equal(done.signature.outcome, "CREDITED");
    assert.equal(done.funding.status, "FUNDED");
    const row = await db.selectFrom("project_funding_accounts").selectAll().where("task_id", "=", t.taskId).executeTakeFirstOrThrow();
    assert.equal(row.last_verified_commitment, "finalized");
    assert.ok(Number(row.last_verified_slot) > 0);
    const dep = await db.selectFrom("project_funding_deposits").selectAll().where("signature", "=", sig).executeTakeFirstOrThrow();
    assert.equal(dep.commitment, "finalized");
  });

  test("an unknown signature is PENDING with no observed commitment", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet);
    const unknown = bs58.encode(Buffer.alloc(64, 9));
    const res = JSON.parse((await verify(t, unknown)).body) as { signature: { outcome: string; observedCommitment: string | null } };
    assert.equal(res.signature.outcome, "PENDING");
    assert.equal(res.signature.observedCommitment, null);
  });

  test("a failed transaction is rejected and credits nothing", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 10n * M, { fail: true });
    const res = await verify(t, sig);
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /TX_FAILED/);
    const f = JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as FundingBody;
    assert.equal(f.confirmedLamports, "0");
  });

  test("wrong program: a transaction that never invokes AtherNull is rejected", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet);
    const pda = (JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as FundingBody).onchainAccount;
    const sig = chain.systemTransfer(wallet, new PublicKey(pda), 50n * M);
    const res = await verify(t, sig);
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /WRONG_PROGRAM/);
  });

  test("a direct SOL transfer to the PDA is never credited, even via history reconciliation", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet);
    const pda = (JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as FundingBody).onchainAccount;
    chain.systemTransfer(wallet, new PublicKey(pda), 80n * M);
    const v = JSON.parse((await verify(t)).body) as { funding: FundingBody };
    assert.equal(v.funding.confirmedLamports, "0");
    assert.equal(v.funding.status, "AWAITING_FUNDS");
    assert.equal((await activate(t)).statusCode, 409);
  });

  test("a deposit to a different task's PDA is rejected for this task", async () => {
    const a = await newFundedSetup();
    const b = await newFundedSetup();
    const sigB = await depositVia(b.t, b.wallet, 50n * M);
    // Same wallet is bound to task A so the customer matches; only the PDA differs.
    await prepare(a.t, b.wallet);
    const res = await verify(a.t, sigB);
    assert.equal(res.statusCode, 422);
    assert.match(res.body, /WRONG_PDA/);
    assert.equal((JSON.parse((await get(a.t, `/v1/jobs/${a.t.taskId}/funding`)).body) as FundingBody).confirmedLamports, "0");
  });

  test("a deposit by a different customer fails (on chain) and is never credited", async () => {
    const { t, wallet } = await newFundedSetup();
    const prep = JSON.parse((await prepare(t, wallet, 10n * M)).body) as { funding: FundingBody };
    const stranger = Keypair.generate();
    const tx = new Transaction({ feePayer: stranger.publicKey, blockhash: bs58.encode(Buffer.alloc(32, 5)), lastValidBlockHeight: 1 }).add(
      buildDepositProjectFundingIx({ programId: PROGRAM_ID, customer: stranger.publicKey, projectFunding: new PublicKey(prep.funding.onchainAccount), amount: 10n * M }),
    );
    tx.sign(stranger);
    const sig = chain.submit(tx);
    const res = await verify(t, sig);
    assert.ok(res.statusCode === 422, res.body); // failed on chain (not the bound customer)
    assert.equal((JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as FundingBody).confirmedLamports, "0");
  });

  test("reconciliation: a real deposit whose signature was never submitted is discovered from chain history", async () => {
    const { t, wallet } = await newFundedSetup();
    await depositVia(t, wallet, 50n * M); // user closes the tab; no signature submitted
    const v = JSON.parse((await verify(t)).body) as { funding: FundingBody };
    assert.equal(v.funding.confirmedLamports, "50000000");
    assert.equal(v.funding.status, "FUNDED");
  });

  test("ledger exceeding the finalized on-chain deposited_amount is refused (INCONSISTENT_STATE)", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 10n * M);
    await verify(t, sig);
    const row = await db.selectFrom("project_funding_accounts").selectAll().where("task_id", "=", t.taskId).executeTakeFirstOrThrow();
    await db
      .insertInto("project_funding_deposits")
      .values({ funding_account_id: row.id, signature: `forged-ledger-row-${Keypair.generate().publicKey.toBase58()}`, amount_base_units: "999999999", depositor_wallet: wallet.publicKey.toBase58(), slot: "1", commitment: "finalized" })
      .execute();
    const res = await verify(t);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /INCONSISTENT_STATE/);
  });

  test("the deposit ledger is append-only", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 10n * M);
    await verify(t, sig);
    await assert.rejects(db.deleteFrom("project_funding_deposits").where("signature", "=", sig).execute());
    await assert.rejects(db.updateTable("project_funding_deposits").set({ amount_base_units: "1" }).where("signature", "=", sig).execute());
  });
});

describe("fail-closed network + RPC behavior", () => {
  test("RPC outage during verification fails closed (503), never funded", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 50n * M);
    chain.outage = new SolanaRpcError("SERVER_ERROR", "getTransaction: HTTP 503", true);
    const res = await verify(t, sig);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /VERIFICATION_UNAVAILABLE/);
    assert.ok(!res.body.includes(SECRET_MARKER));
    chain.outage = null;
    const f = JSON.parse((await get(t, `/v1/jobs/${t.taskId}/funding`)).body) as FundingBody;
    assert.equal(f.confirmedLamports, "0");
  });

  test("429 and timeouts are also retriable 503s", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet);
    for (const err of [new SolanaRpcError("RATE_LIMITED", "HTTP 429", true), new SolanaRpcError("TIMEOUT", "timeout", true)]) {
      chain.outage = err;
      const res = await verify(t);
      assert.equal(res.statusCode, 503);
      assert.match(res.body, /retriable/);
    }
  });

  test("a chain whose genesis hash is not devnet is rejected (hostname/URL is not trusted)", async () => {
    const { t, wallet } = await newFundedSetup();
    await prepare(t, wallet);
    chain.genesisHash = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; // mainnet-beta genesis
    // A fresh runtime so the positive chain-identity cache is empty.
    setFundingRuntimeForTests(makeRuntime(chain, authority, 50n * M));
    const res = await verify(t);
    assert.equal(res.statusCode, 503);
    assert.match(res.body, /NETWORK_MISMATCH/);
  });

  test("activation is rejected unless SOLANA_NETWORK is exactly devnet (mainnet-beta, testnet, unknown, unset)", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 50n * M);
    await verify(t, sig);
    for (const bad of ["mainnet-beta", "testnet", "localnet", ""]) {
      process.env.SOLANA_NETWORK = bad;
      const res = await activate(t);
      assert.equal(res.statusCode, 503, `${bad}: ${res.body}`);
      assert.match(res.body, /NETWORK_NOT_DEVNET/);
      assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");
    }
    delete process.env.SOLANA_NETWORK;
    assert.equal((await activate(t)).statusCode, 503);
    process.env.SOLANA_NETWORK = "devnet";
    assert.equal((await activate(t)).statusCode, 200);
    await neutralize(t.taskId);
  });
});

describe("activation gate", () => {
  test("no funding account -> no QUEUE, even via a direct API call", async () => {
    const t = await createAwaitingFundingTask(app);
    const res = await activate(t);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /NO_FUNDING_ACCOUNT/);
    assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");
  });

  test("an unfunded account (AWAITING_FUNDS) cannot activate", async () => {
    const { t } = await newFundedSetup();
    const res = await activate(t);
    assert.equal(res.statusCode, 409);
    assert.match(res.body, /NOT_FUNDED/);
  });

  test("stale verification + RPC outage fails closed; stale + healthy chain re-verifies and activates", async () => {
    const { t, wallet } = await newFundedSetup();
    const sig = await depositVia(t, wallet, 50n * M);
    await verify(t, sig);
    await sqlStale(t.taskId);

    chain.outage = new SolanaRpcError("SERVER_ERROR", "HTTP 502", true);
    const down = await activate(t);
    assert.equal(down.statusCode, 503);
    assert.equal((await taskStatus(t.taskId)).status, "AWAITING_FUNDING");

    chain.outage = null;
    const up = await activate(t);
    assert.equal(up.statusCode, 200, up.body);
    await neutralize(t.taskId);
  });

  test("concurrent activation produces exactly one transition", async () => {
    const { t, wallet } = await newFundedSetup();
    await verify(t, await depositVia(t, wallet, 50n * M));
    const [a, b] = await Promise.all([activate(t), activate(t)]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], `${a.body} / ${b.body}`);
    const row = await taskStatus(t.taskId);
    assert.equal(row.status, "QUEUED");
    assert.equal(row.version, 2, "exactly one version increment");
    await neutralize(t.taskId);
  });

  test("a different org's session cannot activate or verify", async () => {
    const a = await newFundedSetup();
    const b = await createAwaitingFundingTask(app);
    await verify(a.t, await depositVia(a.t, a.wallet, 50n * M));
    assert.equal((await post(b, `/v1/jobs/${a.t.taskId}/fund`)).statusCode, 404);
    assert.equal((await post(b, `/v1/jobs/${a.t.taskId}/funding/verify`, {})).statusCode, 409); // no funding row visible to org B
    assert.equal((await taskStatus(a.t.taskId)).status, "AWAITING_FUNDING");
  });
});

describe("secrets never leak", () => {
  test("API responses never contain the RPC URL/key or any authority secret", async () => {
    const { t, wallet } = await newFundedSetup();
    const bodies: string[] = [];
    bodies.push((await get(t, `/v1/jobs/${t.taskId}/funding`)).body);
    bodies.push((await prepare(t, wallet, 10n * M)).body);
    chain.outage = new SolanaRpcError("NETWORK", "getTransaction: network error", true);
    bodies.push((await verify(t)).body);
    chain.outage = null;
    for (const b of bodies) {
      assert.ok(!b.includes(SECRET_MARKER));
      assert.ok(!b.includes("helius"), "provider URL must not leak");
      assert.ok(!b.includes(bs58.encode(authority.secretKey)));
    }
  });
});

async function sqlStale(taskId: string) {
  await db
    .updateTable("project_funding_accounts")
    .set({ verified_at: new Date(Date.now() - 60 * 60_000) })
    .where("task_id", "=", taskId)
    .execute();
}
