import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import {
  DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR,
  INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR,
  REFUND_PROJECT_FUNDING_DISCRIMINATOR,
  SETTLE_PROJECT_FUNDING_DISCRIMINATOR,
  U64_MAX,
} from "./constants.js";

function u64le(value: bigint): Buffer {
  if (value < 0n || value > U64_MAX) throw new Error("u64 out of range");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

/** initialize_project_funding(binding_hash, customer, required_amount). Signer: platform authority. */
export function buildInitializeProjectFundingIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  projectFunding: PublicKey;
  bindingHash: Uint8Array;
  customer: PublicKey;
  requiredAmount: bigint;
}): TransactionInstruction {
  if (args.bindingHash.length !== 32) throw new Error("bindingHash must be 32 bytes");
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.projectFunding, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR),
      Buffer.from(args.bindingHash),
      args.customer.toBuffer(),
      u64le(args.requiredAmount),
    ]),
  });
}

/** deposit_project_funding(amount). Signer: the bound customer. Account order: customer, project_funding, system_program. */
export function buildDepositProjectFundingIx(args: {
  programId: PublicKey;
  customer: PublicKey;
  projectFunding: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.customer, isSigner: true, isWritable: true },
      { pubkey: args.projectFunding, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR), u64le(args.amount)]),
  });
}

/**
 * settle_project_funding(release_amount). Signer: platform authority. Pays
 * release_amount of the deposit to `recipient`, the rest to `customer`, and
 * closes the account (rent back to the authority).
 */
export function buildSettleProjectFundingIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  projectFunding: PublicKey;
  recipient: PublicKey;
  customer: PublicKey;
  releaseAmount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.projectFunding, isSigner: false, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: true },
      { pubkey: args.customer, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([Buffer.from(SETTLE_PROJECT_FUNDING_DISCRIMINATOR), u64le(args.releaseAmount)]),
  });
}

/** refund_project_funding(). Signer: platform authority. Returns the whole deposit to `customer` and closes the account. */
export function buildRefundProjectFundingIx(args: {
  programId: PublicKey;
  authority: PublicKey;
  projectFunding: PublicKey;
  customer: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: args.programId,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: true },
      { pubkey: args.projectFunding, isSigner: false, isWritable: true },
      { pubkey: args.customer, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(REFUND_PROJECT_FUNDING_DISCRIMINATOR),
  });
}

/**
 * Decodes a deposit_project_funding instruction's raw data (base58 string as
 * returned by JSON-RPC, or bytes). Returns null if it is not exactly a
 * deposit instruction (wrong discriminator or wrong length).
 */
export function decodeDepositInstructionData(data: string | Uint8Array): { amount: bigint } | null {
  const bytes = typeof data === "string" ? bs58.decode(data) : data;
  if (bytes.length !== 16) return null;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR[i]) return null;
  }
  return { amount: Buffer.from(bytes).readBigUInt64LE(8) };
}
