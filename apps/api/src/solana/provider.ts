// Phase 4E.1 — narrow Solana RPC abstraction (ADR-0013).
//
// SolanaRpcProvider is the ONLY thing funding verification talks to. Helius
// is the transport (standard Solana JSON-RPC only — no enhanced APIs, no
// webhooks, no fallback provider). Helius is NOT the trust authority:
// verification logic decodes real Solana state returned through it.
//
// The RPC URL carries the Helius API key; it is never logged, never put in
// an error message, never sent to the browser or the worker.

import { SolanaRpcError } from "./errors.js";

export type Commitment = "processed" | "confirmed" | "finalized";

export interface RpcInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string; // base58
}

/** getTransaction with encoding "json" (legacy and v0 messages). */
export interface RpcTransaction {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown | null;
    innerInstructions?: { index: number; instructions: { programIdIndex: number }[] }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: {
    signatures: string[];
    message: {
      header: { numRequiredSignatures: number };
      accountKeys: string[];
      instructions: RpcInstruction[];
    };
  };
}

export interface RpcAccount {
  data: Uint8Array;
  owner: string;
  lamports: number;
}

export interface SolanaRpcProvider {
  getGenesisHash(): Promise<string>;
  /** `slot` is the RPC context slot the value was read at. */
  getAccountInfo(address: string, commitment: Commitment): Promise<{ slot: number; value: RpcAccount | null }>;
  /** null when the transaction is not visible at `commitment` yet (or never existed). */
  getTransaction(signature: string, commitment: "confirmed" | "finalized"): Promise<RpcTransaction | null>;
  /** null when the signature is unknown to the node. */
  getSignatureStatus(signature: string): Promise<{ confirmationStatus: Commitment | null; err: unknown | null } | null>;
  getSignaturesForAddress(
    address: string,
    opts: { limit: number; commitment: "confirmed" | "finalized" },
  ): Promise<{ signature: string; err: unknown | null; slot: number }[]>;
  getLatestBlockhash(commitment: Commitment): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Submits a fully-signed transaction (base64). Used only for the authority-signed initialize. */
  sendRawTransaction(base64: string): Promise<string>;
}

export interface HeliusProviderOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Per-call timeout. */
  timeoutMs?: number;
  /** Total attempts per call (1 = no retry). */
  maxAttempts?: number;
  /** Hard cap on one call's total time including retries/backoff. */
  totalBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULTS = { timeoutMs: 8_000, maxAttempts: 3, totalBudgetMs: 15_000 };

export class HeliusSolanaRpcProvider implements SolanaRpcProvider {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly totalBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private nextId = 1;

  constructor(opts: HeliusProviderOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    this.maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
    this.totalBudgetMs = opts.totalBudgetMs ?? DEFAULTS.totalBudgetMs;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  // One JSON-RPC call with bounded retry. Retries ONLY transient failures:
  // timeout, network error, HTTP 429, HTTP 5xx, and JSON-RPC "node
  // unhealthy/rate" codes. Never loops indefinitely inside one HTTP request.
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const started = Date.now();
    let lastErr: SolanaRpcError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (err) {
        if (!(err instanceof SolanaRpcError)) throw err;
        lastErr = err;
        if (!err.retriable || attempt === this.maxAttempts) throw err;
        const backoff = 250 * 3 ** (attempt - 1) * (0.75 + this.random() * 0.5);
        const retryAfter = err.kind === "RATE_LIMITED" ? this.retryAfterMs.get(err) ?? 0 : 0;
        const wait = Math.min(Math.max(backoff, retryAfter), 2_000);
        if (Date.now() - started + wait >= this.totalBudgetMs) throw err;
        await this.sleep(wait);
      }
    }
    throw lastErr ?? new SolanaRpcError("NETWORK", "RPC call failed", true);
  }

  private retryAfterMs = new WeakMap<SolanaRpcError, number>();

  private async callOnce<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
    } catch (err) {
      // Never include `err.message`/URL: node's fetch errors can embed the URL (API key).
      const aborted = (err as { name?: string })?.name === "AbortError";
      throw new SolanaRpcError(aborted ? "TIMEOUT" : "NETWORK", `${method}: ${aborted ? "timeout" : "network error"}`, true);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const e = new SolanaRpcError("RATE_LIMITED", `${method}: HTTP 429`, true);
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) this.retryAfterMs.set(e, ra * 1000);
      throw e;
    }
    if (res.status >= 500) {
      throw new SolanaRpcError("SERVER_ERROR", `${method}: HTTP ${res.status}`, true);
    }
    if (!res.ok) {
      throw new SolanaRpcError("RPC_ERROR", `${method}: HTTP ${res.status}`, false);
    }

    let body: { result?: T; error?: { code?: number; message?: string } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new SolanaRpcError("BAD_RESPONSE", `${method}: unparseable response`, false);
    }
    if (body.error) {
      const code = body.error.code;
      // -32005: node unhealthy / behind; -32004: block not available; -32007/-32009: slot skipped/missing in long-term storage
      const transient = code === -32005 || code === -32004 || code === -32014;
      throw new SolanaRpcError(
        transient ? "SERVER_ERROR" : "RPC_ERROR",
        `${method}: RPC error ${code ?? "?"}`,
        transient,
        code,
      );
    }
    if (!("result" in body)) {
      throw new SolanaRpcError("BAD_RESPONSE", `${method}: missing result`, false);
    }
    return body.result as T;
  }

  async getGenesisHash(): Promise<string> {
    return this.call<string>("getGenesisHash", []);
  }

  async getAccountInfo(address: string, commitment: Commitment) {
    const r = await this.call<{
      context: { slot: number };
      value: { data: [string, string]; owner: string; lamports: number } | null;
    }>("getAccountInfo", [address, { encoding: "base64", commitment }]);
    return {
      slot: r.context.slot,
      value: r.value
        ? {
            data: Uint8Array.from(Buffer.from(r.value.data[0], "base64")),
            owner: r.value.owner,
            lamports: r.value.lamports,
          }
        : null,
    };
  }

  async getTransaction(signature: string, commitment: "confirmed" | "finalized") {
    return this.call<RpcTransaction | null>("getTransaction", [
      signature,
      { encoding: "json", commitment, maxSupportedTransactionVersion: 0 },
    ]);
  }

  async getSignatureStatus(signature: string) {
    const r = await this.call<{
      value: ({ confirmationStatus?: Commitment | null; err: unknown | null } | null)[];
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const v = r.value[0];
    if (!v) return null;
    return { confirmationStatus: v.confirmationStatus ?? null, err: v.err ?? null };
  }

  async getSignaturesForAddress(address: string, opts: { limit: number; commitment: "confirmed" | "finalized" }) {
    return this.call<{ signature: string; err: unknown | null; slot: number }[]>("getSignaturesForAddress", [
      address,
      { limit: opts.limit, commitment: opts.commitment },
    ]);
  }

  async getLatestBlockhash(commitment: Commitment) {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
      { commitment },
    ]);
    return r.value;
  }

  async sendRawTransaction(base64: string) {
    // preflight stays on: a malformed/unauthorized initialize should fail
    // here instead of being silently dropped.
    return this.call<string>("sendTransaction", [base64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  }
}
