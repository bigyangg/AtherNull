// Phase 4E.1 — server-side Solana funding configuration. FAIL CLOSED.
//
//   SOLANA_NETWORK=devnet                (anything else: rejected)
//   SOLANA_RPC_PROVIDER=helius
//   SOLANA_RPC_URL=<Helius DEVNET RPC URL, carries the API key — server only>
//   SOLANA_FUNDING_PROGRAM_ID=<deployed athernull_escrow program id>
//   SOLANA_AUTHORITY_KEYPAIR=<JSON byte array — devnet-only platform authority;
//                             apps/api only, never the worker/browser/logs>
//   SOLANA_AUTHORITY_PUBKEY=<optional; derived from the keypair when omitted>
//   SOLANA_DEMO_REQUIRED_LAMPORTS=50000000   (DEMO_FIXED requirement; default shown)
//
// Chain identity is NOT inferred from the URL: the funding service also
// asserts getGenesisHash == the Solana devnet genesis hash.

import { DEVNET_GENESIS_HASH } from "@athernull/solana-client";
import { Keypair, PublicKey } from "@solana/web3.js";

import { FundingError } from "./errors.js";

export const DEFAULT_DEMO_REQUIRED_LAMPORTS = 50_000_000n;
const MAX_DEMO_REQUIRED_LAMPORTS = 10_000_000_000n; // 10 devnet SOL sanity cap

export interface FundingConfig {
  network: "devnet";
  rpcProvider: "helius";
  rpcUrl: string;
  programId: PublicKey;
  requiredLamports: bigint;
  /** Public key every ProjectFunding account must name as its authority. */
  authorityPublicKey: PublicKey;
  /** Expected devnet genesis hash (constant; overridable ONLY via test injection, never env). */
  genesisHash: string;
  /** Loaded lazily by prepareFunding only — verification/gating never needs it. */
  loadAuthority: () => Keypair;
}

/** The network policy alone, used by the activation gate: SOLANA_NETWORK must be exactly "devnet". */
export function assertDevnetNetworkPolicy(env: NodeJS.ProcessEnv = process.env): void {
  const network = env.SOLANA_NETWORK;
  if (network !== "devnet") {
    throw new FundingError(
      "NETWORK_NOT_DEVNET",
      `Funding is Solana devnet only (SOLANA_NETWORK=${network ? "<non-devnet>" : "<unset>"}); mainnet/testnet/unknown are rejected`,
    );
  }
}

export function loadFundingConfig(env: NodeJS.ProcessEnv = process.env): FundingConfig {
  assertDevnetNetworkPolicy(env);
  if (env.SOLANA_RPC_PROVIDER !== "helius") {
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_RPC_PROVIDER must be 'helius'");
  }
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_RPC_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_RPC_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_RPC_URL must be https");
  }
  // Belt-and-braces ONLY (the genesis-hash assertion is the real check):
  if (/mainnet|testnet/i.test(parsed.hostname)) {
    throw new FundingError("NETWORK_NOT_DEVNET", "SOLANA_RPC_URL hostname names a non-devnet cluster");
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(env.SOLANA_FUNDING_PROGRAM_ID ?? "");
  } catch {
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_FUNDING_PROGRAM_ID is missing or invalid");
  }

  let requiredLamports = DEFAULT_DEMO_REQUIRED_LAMPORTS;
  const rawRequired = env.SOLANA_DEMO_REQUIRED_LAMPORTS;
  if (rawRequired !== undefined && rawRequired !== "") {
    if (!/^[1-9][0-9]*$/.test(rawRequired)) {
      throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_DEMO_REQUIRED_LAMPORTS must be a positive integer (lamports)");
    }
    requiredLamports = BigInt(rawRequired);
    if (requiredLamports > MAX_DEMO_REQUIRED_LAMPORTS) {
      throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_DEMO_REQUIRED_LAMPORTS exceeds the devnet demo cap");
    }
  }

  const loadAuthority = (): Keypair => {
    const raw = env.SOLANA_AUTHORITY_KEYPAIR;
    if (!raw) throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_AUTHORITY_KEYPAIR is not set");
    try {
      const bytes = JSON.parse(raw) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(bytes));
    } catch {
      // Never echo the value.
      throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_AUTHORITY_KEYPAIR is not a valid secret key byte array");
    }
  };
  let authorityPublicKey: PublicKey;
  try {
    authorityPublicKey = env.SOLANA_AUTHORITY_PUBKEY ? new PublicKey(env.SOLANA_AUTHORITY_PUBKEY) : loadAuthority().publicKey;
  } catch (err) {
    if (err instanceof FundingError) throw err;
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_AUTHORITY_PUBKEY is invalid");
  }

  return {
    network: "devnet",
    rpcProvider: "helius",
    rpcUrl,
    programId,
    requiredLamports,
    genesisHash: DEVNET_GENESIS_HASH,
    authorityPublicKey,
    loadAuthority,
  };
}
