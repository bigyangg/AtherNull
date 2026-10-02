// Process-level funding runtime: config + RPC provider, built lazily from the
// environment (fail closed if misconfigured) and overridable by tests so the
// REAL verification logic runs against a deterministic chain double.

import { FundingError } from "./errors.js";
import { loadFundingConfig, type FundingConfig } from "./config.js";
import { HeliusSolanaRpcProvider, type SolanaRpcProvider } from "./provider.js";

export interface FundingRuntime {
  config: FundingConfig;
  provider: SolanaRpcProvider;
  /** Delay between on-chain initialize status polls (tests set 0). */
  pollIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
}

let override: FundingRuntime | null = null;
let cached: FundingRuntime | null = null;

export function getFundingRuntime(): FundingRuntime {
  if (override) return override;
  if (cached) return cached;
  const config = loadFundingConfig(); // throws FundingError (fail closed)
  cached = {
    config,
    provider: new HeliusSolanaRpcProvider({ url: config.rpcUrl }),
    pollIntervalMs: 1_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return cached;
}

/** Test seam: inject a runtime (or null to restore env-based construction). */
export function setFundingRuntimeForTests(rt: FundingRuntime | null): void {
  override = rt;
  cached = null;
  verifiedChains = new WeakSet();
}

// Positive-only cache: a provider whose genesis hash matched devnet once is
// not re-asked on every call. A mismatch is never cached.
let verifiedChains = new WeakSet<SolanaRpcProvider>();

export async function assertDevnetChain(rt: FundingRuntime): Promise<void> {
  if (verifiedChains.has(rt.provider)) return;
  const genesis = await rt.provider.getGenesisHash();
  if (genesis !== rt.config.genesisHash) {
    throw new FundingError(
      "NETWORK_MISMATCH",
      "RPC endpoint chain identity (genesis hash) is not Solana devnet; refusing to verify funding",
    );
  }
  verifiedChains.add(rt.provider);
}
