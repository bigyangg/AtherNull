// Phase 4E.1 — typed funding errors. Every error here is mapped to an HTTP
// status in one place (toHttpError) so verification can distinguish, per the
// approved design:
//   - transaction not visible yet      -> PENDING (not an error)
//   - RPC unavailable                  -> 503, retriable, NEVER "funded"
//   - transaction failed               -> 422 TX_FAILED
//   - wrong program/PDA/customer       -> 422
//   - insufficient amount              -> not an error: PARTIALLY_FUNDED
// Error messages never include the RPC URL (it carries the Helius API key).

import { HttpError } from "../session.js";

export type SolanaRpcErrorKind =
  | "TIMEOUT"
  | "NETWORK"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "BAD_RESPONSE"
  | "RPC_ERROR";

export class SolanaRpcError extends Error {
  constructor(
    public kind: SolanaRpcErrorKind,
    message: string,
    public retriable: boolean,
    public rpcCode?: number,
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

export type FundingErrorCode =
  | "FUNDING_NOT_CONFIGURED"
  | "NETWORK_NOT_DEVNET"
  | "NETWORK_MISMATCH"
  | "VERIFICATION_UNAVAILABLE"
  | "TX_FAILED"
  | "WRONG_PROGRAM"
  | "NOT_A_DEPOSIT"
  | "MULTIPLE_PROGRAM_INSTRUCTIONS"
  | "CPI_NOT_ALLOWED"
  | "WRONG_PDA"
  | "WRONG_CUSTOMER"
  | "ACCOUNT_STATE_MISMATCH"
  | "INCONSISTENT_STATE"
  | "WALLET_NOT_BOUND"
  | "WALLET_CONFLICT"
  | "NO_FUNDING_ACCOUNT"
  | "NOT_FUNDED"
  | "FUNDING_STALE"
  | "ALREADY_FUNDED"
  | "BAD_AMOUNT";

const STATUS: Record<FundingErrorCode, number> = {
  FUNDING_NOT_CONFIGURED: 503,
  NETWORK_NOT_DEVNET: 503,
  NETWORK_MISMATCH: 503,
  VERIFICATION_UNAVAILABLE: 503,
  TX_FAILED: 422,
  WRONG_PROGRAM: 422,
  NOT_A_DEPOSIT: 422,
  MULTIPLE_PROGRAM_INSTRUCTIONS: 422,
  CPI_NOT_ALLOWED: 422,
  WRONG_PDA: 422,
  WRONG_CUSTOMER: 422,
  ACCOUNT_STATE_MISMATCH: 409,
  INCONSISTENT_STATE: 409,
  WALLET_NOT_BOUND: 409,
  WALLET_CONFLICT: 409,
  NO_FUNDING_ACCOUNT: 409,
  NOT_FUNDED: 409,
  FUNDING_STALE: 409,
  ALREADY_FUNDED: 409,
  BAD_AMOUNT: 400,
};

export class FundingError extends Error {
  constructor(
    public code: FundingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FundingError";
  }
  get status(): number {
    return STATUS[this.code];
  }
}

/** Maps funding/RPC errors to HttpError (so sendHttpError handles them). Other errors pass through. */
export function toHttpError(err: unknown): unknown {
  if (err instanceof FundingError) {
    return new HttpError(err.status, `${err.code}: ${err.message}`);
  }
  if (err instanceof SolanaRpcError) {
    // Fail closed: any RPC problem is "could not verify", never "funded".
    return new HttpError(503, `VERIFICATION_UNAVAILABLE: Solana RPC ${err.kind} (retriable)`);
  }
  return err;
}
