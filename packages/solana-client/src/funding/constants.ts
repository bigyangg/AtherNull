// Phase 4E.1 ProjectFunding protocol constants (ADR-0013). Thin by design:
// depends only on @solana/web3.js (+ bs58 for instruction data) — NOT on the
// Anchor runtime. Layouts are hand-coded and pinned against the built IDL by
// funding.test.ts, so a program change that drifts them fails loudly.

/** Solana devnet genesis hash — chain identity, independent of any RPC hostname. */
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const PROJECT_FUNDING_SEED = "pf";
export const BINDING_DOMAIN = "athernull:project-funding:v1";
export const BINDING_VERSION = 0x01;

/** sha256("global:initialize_project_funding")[0..8] */
export const INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR = Uint8Array.from([
  122, 234, 242, 69, 88, 198, 202, 45,
]);
/** sha256("global:deposit_project_funding")[0..8] */
export const DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR = Uint8Array.from([
  143, 166, 57, 13, 1, 140, 188, 164,
]);
/** sha256("account:ProjectFunding")[0..8] */
export const PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR = Uint8Array.from([
  225, 4, 107, 91, 56, 182, 198, 240,
]);

/** 8 disc + 1 version + 32 binding + 32 customer + 32 authority + 3*8 u64 + 1 bump */
export const PROJECT_FUNDING_ACCOUNT_SIZE = 130;

export const U64_MAX = 18_446_744_073_709_551_615n;
