// Phase 4E.1/4E.2 — the REAL funding and settlement services, real RPC JSON shapes, and the REAL
// deployed program bytes, against a local solana-test-validator (no devnet,
// no Helius). Skipped unless SOLANA_LOCAL_VALIDATOR_URL is set, e.g.:
//
//   (WSL)  solana-test-validator --ledger /tmp/ledger --reset \
//            --bpf-program 9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv \
//            contracts/solana/target/deploy/athernull_escrow.so
//   SOLANA_LOCAL_VALIDATOR_URL=http://127.0.0.1:8899 node --import tsx --test \
//            test/project-funding-local-validator.test.ts
//
// The local chain's genesis hash differs from devnet's, so this harness (and
// ONLY a test harness — never env) injects the validator's own genesis hash.
// The deployed-network fail-closed behavior is covered in project-funding.test.ts.
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
import { after, before, describe, test } from "node:test";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";

const URL_ = process.env.SOLANA_LOCAL_VALIDATOR_URL;
const skip = URL_ ? false : "set SOLANA_LOCAL_VALIDATOR_URL to run against a local validator";

describe("project funding against a real local validator", { skip }, () => {
  let app: FastifyInstance;
  let connection: Connection;
  let setFundingRuntimeForTests: typeof import("../src/solana/runtime.js").setFundingRuntimeForTests;
  let db: typeof import("../src/db.js").db;
  let createAwaitingFundingTask: typeof import("./support/app-fixtures.js").createAwaitingFundingTask;
  const programId = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");
  const authority = Keypair.generate();
  // Phase 4E.2: dedicated provider payout wallet, so its balance is exact.
  const recipient = Keypair.generate();
  let airdropTo: (k: PublicKey) => Promise<void>;

  before(async () => {
    ({ db } = await import("../src/db.js"));
    ({ setFundingRuntimeForTests } = await import("../src/solana/runtime.js"));
    ({ createAwaitingFundingTask } = await import("./support/app-fixtures.js"));
    const { buildApp } = await import("../src/app.js");
    const { HeliusSolanaRpcProvider } = await import("../src/solana/provider.js");
    app = await buildApp({ logger: false });
    await app.ready();
    connection = new Connection(URL_!, "confirmed");
    const genesis = await connection.getGenesisHash();
    const airdrop = async (to: PublicKey) => {
      const sig = await connection.requestAirdrop(to, 10 * LAMPORTS_PER_SOL);
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    };
    airdropTo = airdrop;
    await airdrop(authority.publicKey);
    setFundingRuntimeForTests({
      config: {
        network: "devnet",
        rpcProvider: "helius",
        rpcUrl: URL_!,
        programId,
        requiredLamports: 50_000_000n,
        genesisHash: genesis, // local validator identity (test harness only)
        authorityPublicKey: authority.publicKey,
        loadAuthority: () => authority,
        settlementRecipient: recipient.publicKey,
      },
      provider: new HeliusSolanaRpcProvider({ url: URL_! }),
      pollIntervalMs: 500,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
  });

  after(async () => {
    setFundingRuntimeForTests(null);
    await app?.close();
  });

  async function waitFinalized(signature: string) {
    for (let i = 0; i < 90; i++) {
      const st = (await connection.getSignatureStatuses([signature])).value[0];
      if (st?.confirmationStatus === "finalized") return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("transaction did not finalize in time");
  }

  test("create -> prepare (real initialize) -> partial -> direct transfer ignored -> remaining -> verified -> activate", { timeout: 240_000 }, async () => {
    const t = await createAwaitingFundingTask(app);
    const post = (url: string, payload?: object) => app.inject({ method: "POST", url, headers: { cookie: t.jar.header }, payload });

    assert.equal((await post(`/v1/jobs/${t.taskId}/funding`)).statusCode, 201);

    const wallet = Keypair.generate();
    await airdropTo(wallet.publicKey);

    const sendDeposit = async (amount: bigint) => {
      const prep = await post(`/v1/jobs/${t.taskId}/funding/prepare`, { customerWallet: wallet.publicKey.toBase58(), amountLamports: amount.toString() });
      assert.equal(prep.statusCode, 200, prep.body);
      const body = JSON.parse(prep.body) as { state: string; transaction: { base64: string } | null };
      assert.equal(body.state, "READY");
      const tx = Transaction.from(Buffer.from(body.transaction!.base64, "base64"));
      tx.partialSign(wallet);
      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      return sig;
    };

    const s1 = await sendDeposit(20_000_000n);
    // Confirmed but possibly not finalized yet: must not be credited before finalization.
    const early = JSON.parse((await post(`/v1/jobs/${t.taskId}/funding/verify`, { signature: s1 })).body) as {
      signature: { outcome: string };
      funding: { confirmedLamports: string };
    };
    if (early.signature.outcome === "PENDING") assert.equal(early.funding.confirmedLamports, "0");
    await waitFinalized(s1);
    const v1 = JSON.parse((await post(`/v1/jobs/${t.taskId}/funding/verify`, { signature: s1 })).body) as {
      funding: { status: string; confirmedLamports: string; onchainAccount: string };
    };
    assert.equal(v1.funding.status, "PARTIALLY_FUNDED");
    assert.equal(v1.funding.confirmedLamports, "20000000");
    assert.equal((await post(`/v1/jobs/${t.taskId}/fund`)).statusCode, 409);

    // A plain system transfer to the PDA changes lamports, not deposited_amount.
    const pda = new PublicKey(v1.funding.onchainAccount);
    const xfer = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: pda, lamports: 40_000_000 }));
    xfer.feePayer = wallet.publicKey;
    xfer.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    xfer.sign(wallet);
    const xferSig = await connection.sendRawTransaction(xfer.serialize());
    await connection.confirmTransaction(xferSig, "confirmed");
    await waitFinalized(xferSig);
    const wrong = await post(`/v1/jobs/${t.taskId}/funding/verify`, { signature: xferSig });
    assert.equal(wrong.statusCode, 422);
    assert.match(wrong.body, /WRONG_PROGRAM/);

    const s2 = await sendDeposit(30_000_000n);
    await waitFinalized(s2);
    const v2 = JSON.parse((await post(`/v1/jobs/${t.taskId}/funding/verify`, { signature: s2 })).body) as {
      funding: { status: string; confirmedLamports: string; deposits: unknown[] };
    };
    assert.equal(v2.funding.status, "FUNDED");
    assert.equal(v2.funding.confirmedLamports, "50000000");
    assert.equal(v2.funding.deposits.length, 2);

    const act = await post(`/v1/jobs/${t.taskId}/fund`);
    assert.equal(act.statusCode, 200, act.body);
    assert.equal((JSON.parse(act.body) as { status: string }).status, "QUEUED");
    // Neutralize (shared claim queue rule) — straight to the review state,
    // as if the build had run and passed verification.
    await db.updateTable("tasks").set({ status: "AWAITING_ACCEPTANCE" }).where("id", "=", t.taskId).execute();

    // Phase 4E.2: accept settles through the real program.
    const accepted = await post(`/v1/jobs/${t.taskId}/accept`);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const status = await settleUntilDone(post, t.taskId);
    assert.equal(status, "SETTLED");
    assert.equal(await connection.getBalance(recipient.publicKey, "finalized"), 50_000_000);
    assert.equal(await connection.getAccountInfo(pda, "finalized"), null, "project account closed on chain");
  });

  // Drives settlement/verify until the payout is finalized (local finality takes a few seconds).
  async function settleUntilDone(post: (url: string) => Promise<{ body: string }>, taskId: string) {
    for (let i = 0; i < 90; i++) {
      const res = JSON.parse((await post(`/v1/jobs/${taskId}/settlement/verify`)).body) as { taskStatus: string };
      if (res.taskStatus === "SETTLED" || res.taskStatus === "REFUNDED") return res.taskStatus;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("settlement did not finalize in time");
  }

  test("a failed funded build refunds the full deposit to the customer through the real program", { timeout: 240_000 }, async () => {
    const t = await createAwaitingFundingTask(app);
    const post = (url: string, payload?: object) => app.inject({ method: "POST", url, headers: { cookie: t.jar.header }, payload });
    assert.equal((await post(`/v1/jobs/${t.taskId}/funding`)).statusCode, 201);
    const wallet = Keypair.generate();
    await airdropTo(wallet.publicKey);
    const prep = await post(`/v1/jobs/${t.taskId}/funding/prepare`, { customerWallet: wallet.publicKey.toBase58(), amountLamports: "60000000" });
    assert.equal(prep.statusCode, 200, prep.body);
    const tx = Transaction.from(Buffer.from((JSON.parse(prep.body) as { transaction: { base64: string } }).transaction.base64, "base64"));
    tx.partialSign(wallet);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    await waitFinalized(sig);
    assert.equal((await post(`/v1/jobs/${t.taskId}/funding/verify`, { signature: sig })).statusCode, 200);
    await db.updateTable("tasks").set({ status: "FAILED" }).where("id", "=", t.taskId).execute();

    const before = await connection.getBalance(wallet.publicKey, "finalized");
    const refunded = await post(`/v1/jobs/${t.taskId}/refund`);
    assert.equal(refunded.statusCode, 200, refunded.body);
    assert.equal(await settleUntilDone(post, t.taskId), "REFUNDED");
    assert.equal((await connection.getBalance(wallet.publicKey, "finalized")) - before, 60_000_000);
  });
});
