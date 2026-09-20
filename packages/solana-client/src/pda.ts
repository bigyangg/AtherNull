import { PublicKey } from "@solana/web3.js";

/** Matches ESCROW_SEED in contracts/solana/programs/athernull_escrow/src/constants.rs. */
export const ESCROW_SEED = Buffer.from("escrow");

/** Derives the Escrow PDA for a given task_id — one escrow per task (plansol.md Sec 1). */
export function deriveEscrowPda(
  programId: PublicKey,
  taskId: number[] | Uint8Array,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ESCROW_SEED, Buffer.from(taskId)], programId);
}
