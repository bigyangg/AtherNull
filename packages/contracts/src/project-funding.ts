import { z } from "zod";

// Phase 4E.1 — Solana Devnet Project Account + Funding Gate (ADR-0013).
//
// DEVNET ONLY, DEVNET_SOL ONLY, integer lamports only (serialized as decimal
// strings so no JS number ever carries a base-unit amount). Nothing here
// relates budget authorization amount_minor to lamports, and nothing here
// shows a USD equivalent: the requirement is an explicit DEMO_FIXED value.

export const FUNDING_NETWORK = "devnet" as const;
export const FUNDING_ASSET = "DEVNET_SOL" as const;

export const ProjectFundingStatusSchema = z.enum(["AWAITING_FUNDS", "PARTIALLY_FUNDED", "FUNDED"]);
export type ProjectFundingStatus = z.infer<typeof ProjectFundingStatusSchema>;

const LamportsString = z.string().regex(/^[0-9]{1,20}$/);

export const ProjectFundingDepositViewSchema = z.object({
  signature: z.string(),
  amountLamports: LamportsString,
  slot: z.string(),
  verifiedAt: z.string(),
});
export type ProjectFundingDepositView = z.infer<typeof ProjectFundingDepositViewSchema>;

// Phase 4E.2 — the one settle (accepted) or refund (rejected/failed) payout
// of a funding account. Only FINALIZED means the chain has it.
export const ProjectFundingSettlementViewSchema = z.object({
  kind: z.enum(["SETTLE", "REFUND"]),
  status: z.enum(["PENDING", "SUBMITTED", "FINALIZED"]),
  releaseLamports: LamportsString,
  refundLamports: LamportsString,
  recipientWallet: z.string().nullable(),
  customerWallet: z.string(),
  signature: z.string().nullable(),
  finalizedAt: z.string().nullable(),
});
export type ProjectFundingSettlementView = z.infer<typeof ProjectFundingSettlementViewSchema>;

export const ProjectFundingViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  network: z.literal(FUNDING_NETWORK),
  asset: z.literal(FUNDING_ASSET),
  status: ProjectFundingStatusSchema,
  requiredLamports: LamportsString,
  confirmedLamports: LamportsString,
  requirementSource: z.literal("DEMO_FIXED"),
  programId: z.string(),
  onchainAccount: z.string(),
  customerWallet: z.string().nullable(),
  initialized: z.boolean(),
  initSignature: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  deposits: z.array(ProjectFundingDepositViewSchema),
  settlement: ProjectFundingSettlementViewSchema.nullable(),
});
export type ProjectFundingView = z.infer<typeof ProjectFundingViewSchema>;

// Base58 pubkey: 32..44 chars of the base58 alphabet.
export const SolanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
// Base58 signature: 64 bytes -> 86..88 chars.
export const SolanaSignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);

export const PrepareFundingRequestSchema = z.object({
  customerWallet: SolanaAddressSchema,
  // Optional explicit deposit size (lamports, decimal string) so a demo can
  // fund below the requirement first. Defaults to the remaining requirement.
  amountLamports: z.string().regex(/^[1-9][0-9]{0,18}$/).optional(),
});
export type PrepareFundingRequest = z.infer<typeof PrepareFundingRequestSchema>;

export const PrepareFundingResponseSchema = z.object({
  funding: ProjectFundingViewSchema,
  // READY: unsigned deposit transaction included. INITIALIZING: the on-chain
  // account is still being created — retry shortly (no transaction yet).
  state: z.enum(["READY", "INITIALIZING"]),
  transaction: z
    .object({
      base64: z.string(),
      amountLamports: LamportsString,
      lastValidBlockHeight: z.number(),
    })
    .nullable(),
});
export type PrepareFundingResponse = z.infer<typeof PrepareFundingResponseSchema>;

export const VerifyFundingRequestSchema = z.object({
  signature: SolanaSignatureSchema.optional(),
});
export type VerifyFundingRequest = z.infer<typeof VerifyFundingRequestSchema>;

// What the UI may render about a submitted signature. Only FINALIZED credits.
export const VerifyFundingResponseSchema = z.object({
  funding: ProjectFundingViewSchema,
  signature: z
    .object({
      signature: z.string(),
      outcome: z.enum(["CREDITED", "ALREADY_CREDITED", "PENDING"]),
      // processed | confirmed | finalized | null (not yet seen). Display
      // only: nothing is credited before "finalized".
      observedCommitment: z.enum(["processed", "confirmed", "finalized"]).nullable(),
    })
    .nullable(),
});
export type VerifyFundingResponse = z.infer<typeof VerifyFundingResponseSchema>;

// Devnet-scoped Explorer links ONLY. There is deliberately no mainnet variant.
export function devnetExplorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}
export function devnetExplorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

export function formatDevnetSol(lamports: string | bigint): string {
  const v = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const whole = v / 1_000_000_000n;
  const frac = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${frac}`;
}

// POST /v1/jobs/:id/settlement/verify — drives an already-decided settlement
// or refund forward and reports where the task and the payout stand.
export const SettlementProgressResponseSchema = z.object({
  taskStatus: z.string(),
  settlement: ProjectFundingSettlementViewSchema.nullable(),
});
export type SettlementProgressResponse = z.infer<typeof SettlementProgressResponseSchema>;
