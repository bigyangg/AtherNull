import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";

import idlJson from "./idl/athernullEscrow.json";
import type { AthernullEscrow } from "./idl/athernullEscrow.js";
import { deriveEscrowPda, ESCROW_SEED } from "./pda.js";

export type { AthernullEscrow };
export { deriveEscrowPda, ESCROW_SEED };

const idl = idlJson as unknown as AthernullEscrow;

/**
 * These functions only build instructions — they never sign or send. Who
 * signs what is a settlement-policy decision that belongs to the caller
 * (e.g. a future apps/api settlement module), not to this client: fund_escrow
 * needs the customer's own wallet signature, initialize/release/refund need
 * the platform authority's, and timeout_refund needs neither. This package
 * is deliberately not imported by apps/api yet (plansol.md Sec 0/3).
 */
export function getProgram(provider: AnchorProvider): Program<AthernullEscrow> {
  return new Program<AthernullEscrow>(idl, provider);
}

export interface InitializeEscrowArgs {
  taskId: number[];
  customer: PublicKey;
  amount: BN | number;
  deadline: BN | number;
}

/** initialize_escrow: creates the PDA. Signer: platform authority. */
export async function buildInitializeEscrowIx(
  program: Program<AthernullEscrow>,
  authority: PublicKey,
  args: InitializeEscrowArgs,
): Promise<{ instruction: TransactionInstruction; escrow: PublicKey }> {
  const [escrow] = deriveEscrowPda(program.programId, args.taskId);
  const instruction = await program.methods
    .initializeEscrow(args.taskId, args.customer, new BN(args.amount), new BN(args.deadline))
    .accountsPartial({ authority, escrow, systemProgram: SystemProgram.programId })
    .instruction();
  return { instruction, escrow };
}

/** fund_escrow: transfers exactly the amount set at initialize. Signer: the named customer. */
export async function buildFundEscrowIx(
  program: Program<AthernullEscrow>,
  customer: PublicKey,
  escrow: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods
    .fundEscrow()
    .accountsPartial({ customer, escrow, systemProgram: SystemProgram.programId })
    .instruction();
}

export interface ReleaseEscrowArgs {
  authority: PublicKey;
  escrow: PublicKey;
  recipient: PublicKey;
  customer: PublicKey;
  amount: BN | number;
}

/**
 * release_escrow: pays `amount` to `recipient` and the unreleased remainder
 * back to `customer` in the same call — the reconciled-actual-cost model
 * (release what was actually spent, return the rest), not a flat
 * full-balance payout. Signer: platform authority.
 */
export async function buildReleaseEscrowIx(
  program: Program<AthernullEscrow>,
  args: ReleaseEscrowArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .releaseEscrow(new BN(args.amount))
    .accountsPartial({
      authority: args.authority,
      escrow: args.escrow,
      recipient: args.recipient,
      customer: args.customer,
    })
    .instruction();
}

export interface RefundEscrowArgs {
  authority: PublicKey;
  escrow: PublicKey;
  customer: PublicKey;
}

/** refund_escrow: full balance back to customer. Signer: platform authority. */
export async function buildRefundEscrowIx(
  program: Program<AthernullEscrow>,
  args: RefundEscrowArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .refundEscrow()
    .accountsPartial({ authority: args.authority, escrow: args.escrow, customer: args.customer })
    .instruction();
}

/**
 * timeout_refund: same effect as refund_escrow, but deliberately
 * permissionless — `authority` is required as the rent destination (it
 * always reclaims the escrow's rent, on every terminal instruction, not
 * just this one) but is never required to sign here; the on-chain program
 * checks it by address only. The chain enforces `now >= deadline`; calling
 * this before the deadline fails on-chain, not client-side.
 */
export async function buildTimeoutRefundIx(
  program: Program<AthernullEscrow>,
  escrow: PublicKey,
  customer: PublicKey,
  authority: PublicKey,
): Promise<TransactionInstruction> {
  return program.methods
    .timeoutRefund()
    .accountsPartial({ escrow, customer, authority })
    .instruction();
}

/** Fetches and decodes an Escrow account. */
export async function fetchEscrow(program: Program<AthernullEscrow>, escrow: PublicKey) {
  return program.account.escrow.fetch(escrow);
}
