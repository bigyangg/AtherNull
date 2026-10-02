// Phase 4E.1 — pure deposit-transaction parsing. Credits come ONLY from a
// decoded deposit_project_funding instruction, never from a lamport delta:
// a plain system transfer to the PDA is not a deposit.
//
// Accepted shape (documented, enforced): the transaction must contain
// EXACTLY ONE top-level instruction addressed to the AtherNull program, it
// must be deposit_project_funding, and no inner (CPI) instruction may invoke
// the AtherNull program. Other programs' instructions (compute budget, memo,
// wallet guards) are allowed — they cannot add credit. One deposit
// instruction per transaction makes UNIQUE(signature) the deposit identity.

import { decodeDepositInstructionData } from "@athernull/solana-client";

import { FundingError } from "./errors.js";
import type { RpcTransaction } from "./provider.js";

export interface ParsedDeposit {
  amount: bigint;
  customer: string;
  projectFunding: string;
  instructionIndex: number;
}

export function parseDepositTransaction(
  tx: RpcTransaction,
  expected: { signature: string; programId: string; projectFunding: string; customer: string },
): ParsedDeposit {
  if (!tx.meta) throw new FundingError("TX_FAILED", "Transaction has no meta");
  if (tx.meta.err !== null && tx.meta.err !== undefined) {
    throw new FundingError("TX_FAILED", "Transaction failed on chain");
  }
  if (tx.transaction.signatures[0] !== expected.signature) {
    throw new FundingError("TX_FAILED", "Returned transaction does not match the requested signature");
  }

  const msg = tx.transaction.message;
  const keys = [
    ...msg.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];

  const ours = msg.instructions
    .map((ix, index) => ({ ix, index }))
    .filter(({ ix }) => keys[ix.programIdIndex] === expected.programId);
  if (ours.length === 0) {
    throw new FundingError("WRONG_PROGRAM", "Transaction does not invoke the AtherNull funding program");
  }
  if (ours.length > 1) {
    throw new FundingError(
      "MULTIPLE_PROGRAM_INSTRUCTIONS",
      "Phase 4E.1 accepts exactly one AtherNull instruction per transaction",
    );
  }
  for (const inner of tx.meta.innerInstructions ?? []) {
    if (inner.instructions.some((ix) => keys[ix.programIdIndex] === expected.programId)) {
      throw new FundingError("CPI_NOT_ALLOWED", "The AtherNull program must be invoked at the top level, not via CPI");
    }
  }

  const { ix, index } = ours[0]!;
  let decoded: { amount: bigint } | null;
  try {
    decoded = decodeDepositInstructionData(ix.data);
  } catch {
    decoded = null;
  }
  if (!decoded) {
    throw new FundingError("NOT_A_DEPOSIT", "The AtherNull instruction is not deposit_project_funding");
  }
  if (decoded.amount <= 0n) {
    throw new FundingError("NOT_A_DEPOSIT", "Deposit amount must be greater than zero");
  }
  if (ix.accounts.length < 3) {
    throw new FundingError("NOT_A_DEPOSIT", "Deposit instruction has too few accounts");
  }

  const customerIdx = ix.accounts[0]!;
  const pdaIdx = ix.accounts[1]!;
  const customer = keys[customerIdx];
  const projectFunding = keys[pdaIdx];
  if (projectFunding !== expected.projectFunding) {
    throw new FundingError("WRONG_PDA", "Deposit targets a different ProjectFunding account");
  }
  if (customer !== expected.customer) {
    throw new FundingError("WRONG_CUSTOMER", "Deposit was not made by the bound customer wallet");
  }
  if (customerIdx >= msg.header.numRequiredSignatures) {
    throw new FundingError("WRONG_CUSTOMER", "Bound customer did not sign the deposit");
  }

  return { amount: decoded.amount, customer, projectFunding, instructionIndex: index };
}
