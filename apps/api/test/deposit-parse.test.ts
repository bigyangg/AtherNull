// Phase 4E.1 — pure deposit-transaction parsing (no DB, no network). Covers the
// instruction-level rules that the chain double cannot produce by itself:
// wrong customer signer, unsigned customer, CPI invocation, multiple program
// instructions, signature mismatch, v0 loaded addresses, non-deposit data.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildDepositProjectFundingIx, buildInitializeProjectFundingIx } from "@athernull/solana-client";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

import { parseDepositTransaction } from "../src/solana/deposit-parse.js";
import { FundingError, type FundingErrorCode } from "../src/solana/errors.js";
import type { RpcTransaction } from "../src/solana/provider.js";

const PROGRAM = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");
const customer = Keypair.generate().publicKey;
const pda = Keypair.generate().publicKey;
const SIG = bs58.encode(Buffer.alloc(64, 3));

function tx(opts: {
  keys: PublicKey[];
  ixs: { program: number; accounts: number[]; data: Buffer }[];
  signers?: number;
  err?: unknown;
  inner?: { index: number; programIdIndexes: number[] }[];
  sig?: string;
  loaded?: { writable: string[]; readonly: string[] };
}): RpcTransaction {
  return {
    slot: 10,
    blockTime: 1,
    meta: {
      err: opts.err ?? null,
      innerInstructions: (opts.inner ?? []).map((i) => ({ index: i.index, instructions: i.programIdIndexes.map((p) => ({ programIdIndex: p })) })),
      loadedAddresses: opts.loaded,
    },
    transaction: {
      signatures: [opts.sig ?? SIG],
      message: {
        header: { numRequiredSignatures: opts.signers ?? 1 },
        accountKeys: opts.keys.map((k) => k.toBase58()),
        instructions: opts.ixs.map((i) => ({ programIdIndex: i.program, accounts: i.accounts, data: bs58.encode(i.data) })),
      },
    },
  };
}

const depositData = (amount: bigint) =>
  Buffer.from(buildDepositProjectFundingIx({ programId: PROGRAM, customer, projectFunding: pda, amount }).data);

const expected = { signature: SIG, programId: PROGRAM.toBase58(), projectFunding: pda.toBase58(), customer: customer.toBase58() };
// keys: 0 customer(signer), 1 pda, 2 system, 3 program
const KEYS = [customer, pda, SystemProgram.programId, PROGRAM];
const goodIx = (amount = 5n) => ({ program: 3, accounts: [0, 1, 2], data: depositData(amount) });

function rejects(t: RpcTransaction, code: FundingErrorCode) {
  assert.throws(() => parseDepositTransaction(t, expected), (e: unknown) => e instanceof FundingError && e.code === code, code);
}

describe("parseDepositTransaction", () => {
  test("decodes the amount from the instruction data", () => {
    const p = parseDepositTransaction(tx({ keys: KEYS, ixs: [goodIx(20_000_000n)] }), expected);
    assert.equal(p.amount, 20_000_000n);
    assert.equal(p.customer, customer.toBase58());
    assert.equal(p.projectFunding, pda.toBase58());
    assert.equal(p.instructionIndex, 0);
  });

  test("other programs' instructions (compute budget, memo) are allowed and cannot add credit", () => {
    const cb = Keypair.generate().publicKey;
    const p = parseDepositTransaction(
      tx({ keys: [...KEYS, cb], ixs: [{ program: 4, accounts: [], data: Buffer.from([2, 0, 0, 0, 0]) }, goodIx(7n)] }),
      expected,
    );
    assert.equal(p.amount, 7n);
    assert.equal(p.instructionIndex, 1);
  });

  test("v0 loaded (lookup-table) addresses resolve program/account indexes", () => {
    const t = tx({
      keys: [customer],
      loaded: { writable: [pda.toBase58()], readonly: [SystemProgram.programId.toBase58(), PROGRAM.toBase58()] },
      ixs: [{ program: 3, accounts: [0, 1, 2], data: depositData(9n) }],
    });
    assert.equal(parseDepositTransaction(t, expected).amount, 9n);
  });

  test("failed transactions are rejected", () => {
    rejects(tx({ keys: KEYS, ixs: [goodIx()], err: { InstructionError: [0, "Custom"] } }), "TX_FAILED");
  });

  test("a returned transaction for a different signature is rejected", () => {
    rejects(tx({ keys: KEYS, ixs: [goodIx()], sig: bs58.encode(Buffer.alloc(64, 4)) }), "TX_FAILED");
  });

  test("no AtherNull instruction -> WRONG_PROGRAM (e.g. a plain system transfer)", () => {
    rejects(tx({ keys: [customer, pda, SystemProgram.programId], ixs: [{ program: 2, accounts: [0, 1], data: Buffer.alloc(12) }] }), "WRONG_PROGRAM");
  });

  test("two AtherNull instructions in one transaction are rejected (one deposit per tx)", () => {
    rejects(tx({ keys: KEYS, ixs: [goodIx(1n), goodIx(2n)] }), "MULTIPLE_PROGRAM_INSTRUCTIONS");
  });

  test("an AtherNull instruction invoked via CPI is rejected", () => {
    const other = Keypair.generate().publicKey;
    rejects(
      tx({
        keys: [...KEYS, other],
        ixs: [goodIx()],
        inner: [{ index: 0, programIdIndexes: [3] }],
      }),
      "CPI_NOT_ALLOWED",
    );
  });

  test("non-deposit AtherNull data (initialize / garbage / wrong length) is rejected", () => {
    const init = Buffer.from(
      buildInitializeProjectFundingIx({ programId: PROGRAM, authority: customer, projectFunding: pda, bindingHash: new Uint8Array(32), customer, requiredAmount: 1n }).data,
    );
    rejects(tx({ keys: KEYS, ixs: [{ program: 3, accounts: [0, 1, 2], data: init }] }), "NOT_A_DEPOSIT");
    rejects(tx({ keys: KEYS, ixs: [{ program: 3, accounts: [0, 1, 2], data: Buffer.alloc(16) }] }), "NOT_A_DEPOSIT");
    rejects(tx({ keys: KEYS, ixs: [{ program: 3, accounts: [0, 1, 2], data: depositData(1n).subarray(0, 12) }] }), "NOT_A_DEPOSIT");
  });

  test("a zero amount is rejected", () => {
    rejects(tx({ keys: KEYS, ixs: [goodIx(0n)] }), "NOT_A_DEPOSIT");
  });

  test("wrong PDA is rejected", () => {
    const other = Keypair.generate().publicKey;
    rejects(tx({ keys: [customer, other, SystemProgram.programId, PROGRAM], ixs: [goodIx()] }), "WRONG_PDA");
  });

  test("wrong customer is rejected", () => {
    const stranger = Keypair.generate().publicKey;
    rejects(tx({ keys: [stranger, pda, SystemProgram.programId, PROGRAM], ixs: [goodIx()] }), "WRONG_CUSTOMER");
  });

  test("the bound customer must actually be a signer", () => {
    // 2 required signatures -> index 0 signs; put the customer at index 2 (non-signer).
    const payer = Keypair.generate().publicKey;
    rejects(
      tx({
        keys: [payer, pda, customer, SystemProgram.programId, PROGRAM],
        signers: 1,
        ixs: [{ program: 4, accounts: [2, 1, 3], data: depositData(3n) }],
      }),
      "WRONG_CUSTOMER",
    );
  });
});
