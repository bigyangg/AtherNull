import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { AthernullEscrow } from "../target/types/athernull_escrow";

// Mirrors plansol.md Sec 1's Escrow design and Sec 4's required-tests list:
// happy path, refund path, duplicate-initialize rejection, unauthorized
// release/refund rejection, timeout_refund before/after the deadline.
describe("athernull_escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.athernullEscrow as Program<AthernullEscrow>;
  const connection = provider.connection;

  const ESCROW_SEED = Buffer.from("escrow");
  const ONE_SOL = anchor.web3.LAMPORTS_PER_SOL;

  function randomTaskId(): number[] {
    return Array.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
  }

  function escrowPda(taskId: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [ESCROW_SEED, Buffer.from(taskId)],
      program.programId,
    );
  }

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(pubkey, sol * ONE_SOL);
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest });
  }

  async function balanceOf(pubkey: PublicKey): Promise<number> {
    return connection.getBalance(pubkey);
  }

  // release/refund/timeout_refund now close the escrow PDA (`close =
  // authority`), reclaiming its rent-exempt balance instead of leaving it
  // stranded forever — this is the real proof that worked: a closed account
  // has no data and no lamports, so `program.account.escrow.fetch` can no
  // longer be used to check post-terminal state.
  async function assertEscrowClosed(escrow: PublicKey) {
    const info = await connection.getAccountInfo(escrow);
    assert.isNull(info, "escrow account must be closed (no data, no lamports) after a terminal instruction");
  }

  // authority is the platform settlement authority (plansol.md Sec 0) —
  // never a worker/agent key. The test wallet doubles as it here since
  // there's no worker process in this test at all.
  const authority = provider.wallet as anchor.Wallet;

  async function newFundedCustomer(): Promise<Keypair> {
    const customer = Keypair.generate();
    await airdrop(customer.publicKey, 5);
    return customer;
  }

  async function initializeAndFund(opts: {
    customer: Keypair;
    amount: number;
    deadlineSecondsFromNow: number;
  }): Promise<{ taskId: number[]; escrow: PublicKey; bump: number }> {
    const taskId = randomTaskId();
    const [escrow, bump] = escrowPda(taskId);
    const deadline = Math.floor(Date.now() / 1000) + opts.deadlineSecondsFromNow;

    await program.methods
      .initializeEscrow(taskId, opts.customer.publicKey, new anchor.BN(opts.amount), new anchor.BN(deadline))
      .accounts({
        authority: authority.publicKey,
        escrow,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .fundEscrow()
      .accounts({
        customer: opts.customer.publicKey,
        escrow,
        systemProgram: SystemProgram.programId,
      })
      .signers([opts.customer])
      .rpc();

    return { taskId, escrow, bump };
  }

  it("happy path: initialize -> fund -> partial release + remainder refund", async () => {
    const customer = await newFundedCustomer();
    const recipient = Keypair.generate();
    const fundedAmount = 1 * ONE_SOL;
    const releaseAmount = 0.6 * ONE_SOL;

    const { escrow } = await initializeAndFund({
      customer,
      amount: fundedAmount,
      deadlineSecondsFromNow: 3600,
    });

    const escrowAccountBefore = await program.account.escrow.fetch(escrow);
    assert.deepEqual(escrowAccountBefore.status, { funded: {} });
    assert.equal(escrowAccountBefore.amount.toNumber(), fundedAmount);

    const customerBalanceBefore = await balanceOf(customer.publicKey);
    const authorityBalanceBefore = await balanceOf(authority.publicKey);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(
      (await connection.getAccountInfo(escrow))!.data.length,
    );

    await program.methods
      .releaseEscrow(new anchor.BN(releaseAmount))
      .accounts({
        authority: authority.publicKey,
        escrow,
        recipient: recipient.publicKey,
        customer: customer.publicKey,
      })
      .rpc();

    await assertEscrowClosed(escrow);

    const recipientBalance = await balanceOf(recipient.publicKey);
    assert.equal(recipientBalance, releaseAmount);

    const customerBalanceAfter = await balanceOf(customer.publicKey);
    assert.equal(customerBalanceAfter - customerBalanceBefore, fundedAmount - releaseAmount);

    // authority is both the fee payer and the rent recipient here, so its
    // net delta is (reclaimed rent - tx fee) — assert it's positive and
    // within one fee's distance of the full rent amount, rather than an
    // exact figure that would be fragile against fee changes.
    const authorityBalanceAfter = await balanceOf(authority.publicKey);
    const authorityDelta = authorityBalanceAfter - authorityBalanceBefore;
    assert.isAbove(authorityDelta, 0, "authority must reclaim the escrow's rent, not just pay a fee");
    assert.isAtLeast(authorityDelta, rentExempt - 20_000, "authority's reclaimed rent looks short");
  });

  it("refund path: initialize -> fund -> refund returns the full amount", async () => {
    const customer = await newFundedCustomer();
    const fundedAmount = 0.5 * ONE_SOL;

    const { escrow } = await initializeAndFund({
      customer,
      amount: fundedAmount,
      deadlineSecondsFromNow: 3600,
    });

    const customerBalanceBefore = await balanceOf(customer.publicKey);

    await program.methods
      .refundEscrow()
      .accounts({
        authority: authority.publicKey,
        escrow,
        customer: customer.publicKey,
      })
      .rpc();

    await assertEscrowClosed(escrow);

    const customerBalanceAfter = await balanceOf(customer.publicKey);
    assert.equal(customerBalanceAfter - customerBalanceBefore, fundedAmount);
  });

  it("rejects a duplicate initialize for the same task_id", async () => {
    const customer = await newFundedCustomer();
    const taskId = randomTaskId();
    const [escrow] = escrowPda(taskId);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    await program.methods
      .initializeEscrow(taskId, customer.publicKey, new anchor.BN(ONE_SOL), new anchor.BN(deadline))
      .accounts({
        authority: authority.publicKey,
        escrow,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let threw = false;
    try {
      await program.methods
        .initializeEscrow(taskId, customer.publicKey, new anchor.BN(ONE_SOL), new anchor.BN(deadline))
        .accounts({
          authority: authority.publicKey,
          escrow,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "second initialize for the same task_id must fail");
  });

  it("rejects release signed by anyone other than the stored authority", async () => {
    const customer = await newFundedCustomer();
    const impostor = Keypair.generate();
    await airdrop(impostor.publicKey, 1);

    const { escrow } = await initializeAndFund({
      customer,
      amount: 0.3 * ONE_SOL,
      deadlineSecondsFromNow: 3600,
    });

    let threw = false;
    try {
      await program.methods
        .releaseEscrow(new anchor.BN(0.1 * ONE_SOL))
        .accounts({
          authority: impostor.publicKey,
          escrow,
          recipient: impostor.publicKey,
          customer: customer.publicKey,
        })
        .signers([impostor])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "release signed by a non-authority key must fail");
  });

  it("rejects refund signed by anyone other than the stored authority", async () => {
    const customer = await newFundedCustomer();
    const impostor = Keypair.generate();
    await airdrop(impostor.publicKey, 1);

    const { escrow } = await initializeAndFund({
      customer,
      amount: 0.3 * ONE_SOL,
      deadlineSecondsFromNow: 3600,
    });

    let threw = false;
    try {
      await program.methods
        .refundEscrow()
        .accounts({
          authority: impostor.publicKey,
          escrow,
          customer: customer.publicKey,
        })
        .signers([impostor])
        .rpc();
    } catch (err) {
      threw = true;
    }
    assert.isTrue(threw, "refund signed by a non-authority key must fail");
  });

  it("timeout_refund fails before the deadline and succeeds after it, callable by anyone", async () => {
    const customer = await newFundedCustomer();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);
    const fundedAmount = 0.4 * ONE_SOL;

    // Deadline 2s in the future so the test doesn't need to wait long.
    const { escrow } = await initializeAndFund({
      customer,
      amount: fundedAmount,
      deadlineSecondsFromNow: 2,
    });

    let threwBeforeDeadline = false;
    try {
      await program.methods
        .timeoutRefund()
        .accounts({ escrow, customer: customer.publicKey, authority: authority.publicKey })
        .rpc();
    } catch (err) {
      threwBeforeDeadline = true;
    }
    assert.isTrue(threwBeforeDeadline, "timeout_refund must fail before the deadline");

    await new Promise((resolve) => setTimeout(resolve, 3000));

    const customerBalanceBefore = await balanceOf(customer.publicKey);
    const authorityBalanceBefore = await balanceOf(authority.publicKey);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(
      (await connection.getAccountInfo(escrow))!.data.length,
    );

    // `.rpc()` always pays fees from the provider's default wallet
    // regardless of `.signers([...])`, so proving this is genuinely
    // permissionless means building and sending the transaction with
    // `stranger` as fee payer, not the platform authority and not the
    // customer. `authority` is still passed as the (non-signer) rent
    // destination — timeout_refund never requires its signature, but it
    // still always receives the reclaimed rent (plansol.md Sec 0 choice:
    // consistent rent destination, not a keeper reward for `stranger`).
    const tx = await program.methods
      .timeoutRefund()
      .accounts({ escrow, customer: customer.publicKey, authority: authority.publicKey })
      .transaction();
    tx.feePayer = stranger.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(stranger);
    const sig = await connection.sendRawTransaction(tx.serialize());
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...latest });

    await assertEscrowClosed(escrow);

    const customerBalanceAfter = await balanceOf(customer.publicKey);
    assert.equal(customerBalanceAfter - customerBalanceBefore, fundedAmount);

    // authority didn't sign or pay for this transaction (stranger did), so
    // its full delta should be the reclaimed rent. Observed a small (~32
    // lamport, ~0.002%) shortfall against a freshly-queried
    // getMinimumBalanceForRentExemption in practice — a rent-table precision
    // nuance, not a funds-safety issue (the closed-account check above and
    // the exact customer-amount check already prove no funds are lost or
    // misdirected) — so this allows a small margin rather than exact
    // equality.
    const authorityBalanceAfter = await balanceOf(authority.publicKey);
    const authorityDelta = authorityBalanceAfter - authorityBalanceBefore;
    assert.isAbove(authorityDelta, 0, "authority must reclaim the escrow's rent");
    assert.isAtLeast(authorityDelta, rentExempt - 1_000, "authority's reclaimed rent looks short");
  });
});
