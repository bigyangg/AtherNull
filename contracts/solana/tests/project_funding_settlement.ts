import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import { AthernullEscrow } from "../target/types/athernull_escrow";

// Phase 4E.2 settle/refund integration tests (local validator only).
describe("athernull_escrow — ProjectFunding settlement (4E.2)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.athernullEscrow as Program<AthernullEscrow>;
  const connection = provider.connection;
  const authority = provider.wallet as anchor.Wallet;

  const PF_SEED = Buffer.from("pf");
  const REQUIRED = 50_000_000;
  const M = 1_000_000;

  function randomHash(): number[] {
    return Array.from(createHash("sha256").update(Keypair.generate().publicKey.toBytes()).digest());
  }

  function pda(hash: number[]): PublicKey {
    return PublicKey.findProgramAddressSync([PF_SEED, Buffer.from(hash)], program.programId)[0];
  }

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest });
  }

  async function expectFail(p: Promise<unknown>, match: RegExp) {
    try {
      await p;
    } catch (e: any) {
      const text = `${e?.message ?? ""} ${(e?.logs ?? []).join(" ")} ${e?.error?.errorCode?.code ?? ""}`;
      assert.match(text, match, `unexpected failure: ${text}`);
      return;
    }
    assert.fail("expected the transaction to fail");
  }

  async function funded(depositAmount: number) {
    const customer = Keypair.generate();
    await airdrop(customer.publicKey, 2);
    const hash = randomHash();
    const projectFunding = pda(hash);
    await program.methods
      .initializeProjectFunding(hash, customer.publicKey, new BN(REQUIRED))
      .accountsPartial({ authority: authority.publicKey, projectFunding, systemProgram: SystemProgram.programId })
      .rpc();
    await program.methods
      .depositProjectFunding(new BN(depositAmount))
      .accountsPartial({ customer: customer.publicKey, projectFunding, systemProgram: SystemProgram.programId })
      .signers([customer])
      .rpc();
    return { customer, projectFunding };
  }

  // Read at the same commitment `.rpc()` confirms at, so reads never lag a write.
  const balance = (k: PublicKey) => connection.getBalance(k, "processed");

  it("settle releases to the recipient, returns the rest to the customer, and closes the account", async () => {
    const { customer, projectFunding } = await funded(80 * M);
    const recipient = Keypair.generate().publicKey;
    const customerBefore = await balance(customer.publicKey);
    const rent = await balance(projectFunding);

    await program.methods
      .settleProjectFunding(new BN(REQUIRED))
      .accountsPartial({ authority: authority.publicKey, projectFunding, recipient, customer: customer.publicKey })
      .rpc();

    assert.equal(await balance(recipient), REQUIRED);
    assert.equal((await balance(customer.publicKey)) - customerBefore, 30 * M);
    assert.equal(await connection.getAccountInfo(projectFunding, "processed"), null, "account closed");
    assert.ok(rent > 80 * M, "PDA held rent + deposit");
  });

  it("settle cannot release more than was deposited", async () => {
    const { customer, projectFunding } = await funded(30 * M);
    await expectFail(
      program.methods
        .settleProjectFunding(new BN(30 * M + 1))
        .accountsPartial({ authority: authority.publicKey, projectFunding, recipient: Keypair.generate().publicKey, customer: customer.publicKey })
        .rpc(),
      /SettlementExceedsDeposit/,
    );
  });

  it("only the recorded authority can settle or refund", async () => {
    const { customer, projectFunding } = await funded(50 * M);
    const intruder = Keypair.generate();
    await airdrop(intruder.publicKey, 1);
    await expectFail(
      program.methods
        .settleProjectFunding(new BN(REQUIRED))
        .accountsPartial({ authority: intruder.publicKey, projectFunding, recipient: intruder.publicKey, customer: customer.publicKey })
        .signers([intruder])
        .rpc(),
      /Unauthorized/,
    );
    await expectFail(
      program.methods
        .refundProjectFunding()
        .accountsPartial({ authority: intruder.publicKey, projectFunding, customer: customer.publicKey })
        .signers([intruder])
        .rpc(),
      /Unauthorized/,
    );
  });

  it("the payout cannot be redirected to a wallet other than the bound customer", async () => {
    const { projectFunding } = await funded(50 * M);
    await expectFail(
      program.methods
        .refundProjectFunding()
        .accountsPartial({ authority: authority.publicKey, projectFunding, customer: Keypair.generate().publicKey })
        .rpc(),
      /ConstraintHasOne|has one/i,
    );
  });

  it("refund returns the whole deposit, and a closed account can never pay out again", async () => {
    const { customer, projectFunding } = await funded(60 * M);
    const before = await balance(customer.publicKey);
    await program.methods
      .refundProjectFunding()
      .accountsPartial({ authority: authority.publicKey, projectFunding, customer: customer.publicKey })
      .rpc();
    assert.equal((await balance(customer.publicKey)) - before, 60 * M);

    await expectFail(
      program.methods
        .refundProjectFunding()
        .accountsPartial({ authority: authority.publicKey, projectFunding, customer: customer.publicKey })
        .rpc(),
      /AccountNotInitialized|not initialized|could not find/i,
    );
    await expectFail(
      program.methods
        .settleProjectFunding(new BN(1))
        .accountsPartial({ authority: authority.publicKey, projectFunding, recipient: Keypair.generate().publicKey, customer: customer.publicKey })
        .rpc(),
      /AccountNotInitialized|not initialized|could not find/i,
    );
  });

  it("lamports sent to the PDA outside a deposit are not paid to the customer", async () => {
    const { customer, projectFunding } = await funded(50 * M);
    const stray = Keypair.generate();
    await airdrop(stray.publicKey, 1);
    await provider.sendAndConfirm(
      new Transaction().add(SystemProgram.transfer({ fromPubkey: stray.publicKey, toPubkey: projectFunding, lamports: 7 * M })),
      [stray],
    );
    const before = await balance(customer.publicKey);
    await program.methods
      .refundProjectFunding()
      .accountsPartial({ authority: authority.publicKey, projectFunding, customer: customer.publicKey })
      .rpc();
    assert.equal((await balance(customer.publicKey)) - before, 50 * M, "only the deposited amount is refunded");
  });

  it("wire format: settle/refund data matches the shared client's hand-coded layout", () => {
    const d = (n: string) => createHash("sha256").update(n).digest().subarray(0, 8);
    const settle = program.coder.instruction.encode("settleProjectFunding", { releaseAmount: new BN(REQUIRED) });
    assert.deepEqual(Buffer.from(settle), Buffer.concat([d("global:settle_project_funding"), Buffer.from(new BN(REQUIRED).toArray("le", 8))]));
    const refund = program.coder.instruction.encode("refundProjectFunding", {});
    assert.deepEqual(Buffer.from(refund), d("global:refund_project_funding"));
  });
});
