import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import { createHash } from "crypto";
import { AthernullEscrow } from "../target/types/athernull_escrow";

// Phase 4E.1 ProjectFunding integration tests (local validator only).
describe("athernull_escrow — ProjectFunding (4E.1)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.athernullEscrow as Program<AthernullEscrow>;
  const connection = provider.connection;
  const authority = provider.wallet as anchor.Wallet;

  const PF_SEED = Buffer.from("pf");
  const REQUIRED = 50_000_000;

  function uuidBytes(): Buffer {
    return Buffer.from(Keypair.generate().publicKey.toBytes().slice(0, 16));
  }

  // Same canonical algorithm as packages/solana-client computeBindingHash.
  function bindingHash(org: Buffer, project: Buffer, task: Buffer, auth: Buffer): number[] {
    return Array.from(
      createHash("sha256")
        .update(Buffer.from("athernull:project-funding:v1"))
        .update(Buffer.from([1]))
        .update(org)
        .update(project)
        .update(task)
        .update(auth)
        .digest(),
    );
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

  async function setup(required = REQUIRED) {
    const customer = Keypair.generate();
    await airdrop(customer.publicKey, 5);
    const hash = bindingHash(uuidBytes(), uuidBytes(), uuidBytes(), uuidBytes());
    const projectFunding = pda(hash);
    await program.methods
      .initializeProjectFunding(hash, customer.publicKey, new BN(required))
      .accountsPartial({ authority: authority.publicKey, projectFunding, systemProgram: SystemProgram.programId })
      .rpc();
    return { customer, hash, projectFunding };
  }

  function deposit(customer: Keypair, projectFunding: PublicKey, amount: number | BN) {
    return program.methods
      .depositProjectFunding(new BN(amount))
      .accountsPartial({ customer: customer.publicKey, projectFunding, systemProgram: SystemProgram.programId })
      .signers([customer])
      .rpc();
  }

  it("initializes with the exact PDA and state", async () => {
    const { customer, hash, projectFunding } = await setup();
    const acc = await program.account.projectFunding.fetch(projectFunding);
    assert.equal(acc.version, 1);
    assert.deepEqual(Array.from(acc.bindingHash), hash);
    assert.equal(acc.customer.toBase58(), customer.publicKey.toBase58());
    assert.equal(acc.authority.toBase58(), authority.publicKey.toBase58());
    assert.equal(acc.requiredAmount.toNumber(), REQUIRED);
    assert.equal(acc.depositedAmount.toNumber(), 0);
    assert.equal(acc.depositCount.toNumber(), 0);
    const info = await connection.getAccountInfo(projectFunding);
    assert.equal(info!.owner.toBase58(), program.programId.toBase58());
    assert.equal(info!.data.length, 130);
  });

  it("wire format: instruction data and account layout match the shared client's hand-coded layout", async () => {
    const d = (n: string) => createHash("sha256").update(n).digest().subarray(0, 8);
    const data = program.coder.instruction.encode("depositProjectFunding", { amount: new BN(20_000_000) });
    assert.deepEqual(Buffer.from(data), Buffer.concat([d("global:deposit_project_funding"), Buffer.from(new BN(20_000_000).toArray("le", 8))]));
    const { projectFunding } = await setup();
    const raw = (await connection.getAccountInfo(projectFunding))!.data;
    assert.deepEqual(Buffer.from(raw.subarray(0, 8)), d("account:ProjectFunding"));
  });

  it("rejects duplicate initialization of the same binding", async () => {
    const { customer, hash, projectFunding } = await setup();
    await expectFail(
      program.methods
        .initializeProjectFunding(hash, customer.publicKey, new BN(REQUIRED))
        .accountsPartial({ authority: authority.publicKey, projectFunding, systemProgram: SystemProgram.programId })
        .rpc(),
      /already in use|custom program error: 0x0/i,
    );
  });

  it("rejects zero required amount and default customer", async () => {
    const h1 = bindingHash(uuidBytes(), uuidBytes(), uuidBytes(), uuidBytes());
    await expectFail(
      program.methods
        .initializeProjectFunding(h1, Keypair.generate().publicKey, new BN(0))
        .accountsPartial({ authority: authority.publicKey, projectFunding: pda(h1), systemProgram: SystemProgram.programId })
        .rpc(),
      /InvalidRequiredAmount/,
    );
    const h2 = bindingHash(uuidBytes(), uuidBytes(), uuidBytes(), uuidBytes());
    await expectFail(
      program.methods
        .initializeProjectFunding(h2, PublicKey.default, new BN(REQUIRED))
        .accountsPartial({ authority: authority.publicKey, projectFunding: pda(h2), systemProgram: SystemProgram.programId })
        .rpc(),
      /InvalidCustomer/,
    );
  });

  it("rejects a PDA that does not match the binding hash argument (wrong binding)", async () => {
    const customer = Keypair.generate().publicKey;
    const hashA = bindingHash(uuidBytes(), uuidBytes(), uuidBytes(), uuidBytes());
    const hashB = bindingHash(uuidBytes(), uuidBytes(), uuidBytes(), uuidBytes());
    await expectFail(
      program.methods
        .initializeProjectFunding(hashA, customer, new BN(REQUIRED))
        .accountsPartial({ authority: authority.publicKey, projectFunding: pda(hashB), systemProgram: SystemProgram.programId })
        .rpc(),
      /ConstraintSeeds|seeds constraint/i,
    );
  });

  it("deposit moves exactly the amount into the PDA and records it", async () => {
    const { customer, projectFunding } = await setup();
    const before = await connection.getBalance(projectFunding);
    await deposit(customer, projectFunding, 20_000_000);
    const acc = await program.account.projectFunding.fetch(projectFunding);
    assert.equal(acc.depositedAmount.toNumber(), 20_000_000);
    assert.equal(acc.depositCount.toNumber(), 1);
    assert.equal((await connection.getBalance(projectFunding)) - before, 20_000_000);
  });

  it("supports multiple deposits (20m + 15m + 15m = 50m)", async () => {
    const { customer, projectFunding } = await setup();
    await deposit(customer, projectFunding, 20_000_000);
    await deposit(customer, projectFunding, 15_000_000);
    await deposit(customer, projectFunding, 15_000_000);
    const acc = await program.account.projectFunding.fetch(projectFunding);
    assert.equal(acc.depositedAmount.toNumber(), 50_000_000);
    assert.equal(acc.depositCount.toNumber(), 3);
  });

  it("allows overfunding and preserves the actual amount (80m vs 50m required)", async () => {
    const { customer, projectFunding } = await setup();
    await deposit(customer, projectFunding, 80_000_000);
    const acc = await program.account.projectFunding.fetch(projectFunding);
    assert.equal(acc.requiredAmount.toNumber(), 50_000_000);
    assert.equal(acc.depositedAmount.toNumber(), 80_000_000);
  });

  it("rejects a zero deposit", async () => {
    const { customer, projectFunding } = await setup();
    await expectFail(deposit(customer, projectFunding, 0), /ZeroAmount/);
  });

  it("rejects a deposit from a customer other than the bound one", async () => {
    const { projectFunding } = await setup();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 2);
    await expectFail(deposit(stranger, projectFunding, 1_000_000), /ConstraintHasOne|has_one/i);
  });

  it("rejects a deposit naming a PDA belonging to a different project's customer", async () => {
    const a = await setup();
    const b = await setup();
    await expectFail(deposit(a.customer, b.projectFunding, 1_000_000), /ConstraintHasOne|has_one/i);
  });

  it("rejects a deposit to an account that is not a ProjectFunding PDA", async () => {
    const { customer } = await setup();
    await expectFail(deposit(customer, Keypair.generate().publicKey, 1_000_000), /AccountNotInitialized|3012|owner/i);
  });

  it("a direct system transfer to the PDA is NOT a deposit", async () => {
    const { customer, projectFunding } = await setup();
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: customer.publicKey, toPubkey: projectFunding, lamports: 7_000_000 }),
    );
    await provider.sendAndConfirm(tx, [customer]);
    const acc = await program.account.projectFunding.fetch(projectFunding);
    assert.equal(acc.depositedAmount.toNumber(), 0);
    assert.equal(acc.depositCount.toNumber(), 0);
  });
});
