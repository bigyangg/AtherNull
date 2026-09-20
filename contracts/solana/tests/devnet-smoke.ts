import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import { AthernullEscrow } from "../target/types/athernull_escrow";

// plansol.md Sec 3/4's "devnet smoke test": same happy path as the localnet
// suite, against real devnet. Deliberately NOT the full localnet suite run
// against devnet — devnet's airdrop faucet is rate-limited (unlike
// localnet's free airdrops), so test wallets here are funded via
// `solana transfer` from the already-funded deploy wallet instead of
// requestAirdrop, and amounts are kept small to conserve real devnet SOL.
//
// Run with: pnpm exec ts-mocha -p ./tsconfig.json -t 60000 tests/devnet-smoke.ts
// against ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
describe("athernull_escrow — devnet smoke test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.athernullEscrow as Program<AthernullEscrow>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const ESCROW_SEED = Buffer.from("escrow");
  const FUNDED_AMOUNT = 0.02 * LAMPORTS_PER_SOL;
  const RELEASE_AMOUNT = 0.012 * LAMPORTS_PER_SOL;
  const RENT_BUFFER = 0.002 * LAMPORTS_PER_SOL; // covers the customer keypair's own rent-exemption

  function randomTaskId(): number[] {
    return Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
  }

  function escrowPda(taskId: number[]): PublicKey {
    return PublicKey.findProgramAddressSync([ESCROW_SEED, Buffer.from(taskId)], program.programId)[0];
  }

  async function balanceOf(pubkey: PublicKey): Promise<number> {
    return connection.getBalance(pubkey);
  }

  async function fundFromPayer(to: PublicKey, lamports: number) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports }),
    );
    const sig = await provider.sendAndConfirm(tx, [payer]);
    return sig;
  }

  it("initialize -> fund -> release (real devnet SOL, real confirmation)", async () => {
    const customer = Keypair.generate();
    const recipient = Keypair.generate();

    // Funded via transfer from the already-funded deploy wallet, not the
    // devnet faucet (rate-limited) — this is the point of this test file.
    await fundFromPayer(customer.publicKey, FUNDED_AMOUNT + RENT_BUFFER);

    const taskId = randomTaskId();
    const escrow = escrowPda(taskId);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const initSig = await program.methods
      .initializeEscrow(taskId, customer.publicKey, new anchor.BN(FUNDED_AMOUNT), new anchor.BN(deadline))
      .accounts({ authority: payer.publicKey, escrow, systemProgram: SystemProgram.programId })
      .rpc();
    console.log("initialize_escrow:", initSig);

    const fundSig = await program.methods
      .fundEscrow()
      .accounts({ customer: customer.publicKey, escrow, systemProgram: SystemProgram.programId })
      .signers([customer])
      .rpc();
    console.log("fund_escrow:", fundSig);

    const escrowAfterFund = await program.account.escrow.fetch(escrow);
    assert.deepEqual(escrowAfterFund.status, { funded: {} });
    assert.equal(escrowAfterFund.amount.toNumber(), FUNDED_AMOUNT);

    const customerBalanceBeforeRelease = await balanceOf(customer.publicKey);
    const payerBalanceBeforeRelease = await balanceOf(payer.publicKey);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(
      (await connection.getAccountInfo(escrow))!.data.length,
    );

    const releaseSig = await program.methods
      .releaseEscrow(new anchor.BN(RELEASE_AMOUNT))
      .accounts({ authority: payer.publicKey, escrow, recipient: recipient.publicKey, customer: customer.publicKey })
      .rpc();
    console.log("release_escrow:", releaseSig);

    // release_escrow closes the escrow PDA (`close = authority`), reclaiming
    // its rent-exempt balance instead of leaving it stranded — fetch on a
    // closed account throws, so check for its absence instead.
    const escrowInfoAfterRelease = await connection.getAccountInfo(escrow);
    assert.isNull(escrowInfoAfterRelease, "escrow account must be closed after release");

    const recipientBalance = await balanceOf(recipient.publicKey);
    assert.equal(recipientBalance, RELEASE_AMOUNT, "recipient must receive exactly the released amount");

    const customerBalanceAfterRelease = await balanceOf(customer.publicKey);
    assert.equal(
      customerBalanceAfterRelease - customerBalanceBeforeRelease,
      FUNDED_AMOUNT - RELEASE_AMOUNT,
      "customer must receive exactly the unreleased remainder",
    );

    // payer is both fee payer and rent recipient here (same wallet as
    // authority), so its net delta is (reclaimed rent - tx fee).
    const payerBalanceAfterRelease = await balanceOf(payer.publicKey);
    const payerDelta = payerBalanceAfterRelease - payerBalanceBeforeRelease;
    assert.isAbove(payerDelta, 0, "authority must reclaim the escrow's rent, not just pay a fee");
    assert.isAtLeast(payerDelta, rentExempt - 20_000, "authority's reclaimed rent looks short");
  });
});
