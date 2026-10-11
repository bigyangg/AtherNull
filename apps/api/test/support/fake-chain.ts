// Deterministic Solana chain double implementing ONLY the SolanaRpcProvider
// transport interface. The funding verification/business logic under test is
// the real code; this stands in for the network + the on-chain program's
// state transitions (account bytes are written in the real ProjectFunding
// layout, transactions are returned in real getTransaction "json" shape built
// from real compiled web3.js messages).

import {
  DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR,
  DEVNET_GENESIS_HASH,
  INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR,
  PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR,
  PROJECT_FUNDING_ACCOUNT_SIZE,
  REFUND_PROJECT_FUNDING_DISCRIMINATOR,
  SETTLE_PROJECT_FUNDING_DISCRIMINATOR,
} from "@athernull/solana-client";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { SolanaRpcError } from "../../src/solana/errors.js";
import type {
  Commitment,
  RpcAccount,
  RpcTransaction,
  SolanaRpcProvider,
} from "../../src/solana/provider.js";
import type { FundingConfig } from "../../src/solana/config.js";
import type { FundingRuntime } from "../../src/solana/runtime.js";

type Stage = "processed" | "confirmed" | "finalized";
const ORDER: Stage[] = ["processed", "confirmed", "finalized"];

interface PfState {
  binding: Uint8Array;
  customer: PublicKey;
  authority: PublicKey;
  required: bigint;
  deposited: bigint;
  count: bigint;
  bump: number;
}

interface StoredTx {
  rpc: RpcTransaction;
  stage: Stage;
  err: unknown | null;
  // state change to apply to the account when this tx reaches `finalized`.
  apply?: () => void;
}

function encodeAccount(s: PfState): Uint8Array {
  const raw = Buffer.alloc(PROJECT_FUNDING_ACCOUNT_SIZE);
  Buffer.from(PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR).copy(raw, 0);
  raw.writeUInt8(1, 8);
  Buffer.from(s.binding).copy(raw, 9);
  s.customer.toBuffer().copy(raw, 41);
  s.authority.toBuffer().copy(raw, 73);
  raw.writeBigUInt64LE(s.required, 105);
  raw.writeBigUInt64LE(s.deposited, 113);
  raw.writeBigUInt64LE(s.count, 121);
  raw.writeUInt8(s.bump, 129);
  return Uint8Array.from(raw);
}

export class FakeChain implements SolanaRpcProvider {
  genesisHash = DEVNET_GENESIS_HASH;
  /** All calls throw this while set (RPC outage / 429 / 5xx simulation). */
  outage: SolanaRpcError | null = null;
  readonly calls: string[] = [];

  private slot = 1_000;
  private blockHeight = 5_000;
  // address -> {live state, finalized state}
  private live = new Map<string, PfState>();
  private finalizedState = new Map<string, PfState>();
  private txs = new Map<string, StoredTx>();
  private byAddress = new Map<string, string[]>();
  private sendCount = 0;
  /** If true, newly submitted transactions stop at `confirmed` until finalize() is called. */
  holdAtConfirmed = false;
  /** Phase 4E.2: lamports paid out of closed funding accounts, by wallet. */
  readonly payouts = new Map<string, bigint>();
  private credit(wallet: string, lamports: bigint) {
    this.payouts.set(wallet, (this.payouts.get(wallet) ?? 0n) + lamports);
  }

  constructor(public readonly programId: PublicKey) {}

  // ------------------------------------------------------------ provider

  private guard(method: string) {
    this.calls.push(method);
    if (this.outage) throw this.outage;
  }

  async getGenesisHash() {
    this.guard("getGenesisHash");
    return this.genesisHash;
  }

  async getAccountInfo(address: string, commitment: Commitment) {
    this.guard("getAccountInfo");
    const src = commitment === "finalized" ? this.finalizedState : this.live;
    const st = src.get(address);
    const value: RpcAccount | null = st
      ? { data: encodeAccount(st), owner: this.programId.toBase58(), lamports: 1_600_000 + Number(st.deposited) }
      : null;
    return { slot: this.slot, value };
  }

  async getTransaction(signature: string, commitment: "confirmed" | "finalized") {
    this.guard("getTransaction");
    const t = this.txs.get(signature);
    if (!t) return null;
    if (ORDER.indexOf(t.stage) < ORDER.indexOf(commitment)) return null;
    return t.rpc;
  }

  async getSignatureStatus(signature: string) {
    this.guard("getSignatureStatus");
    const t = this.txs.get(signature);
    if (!t) return null;
    return { confirmationStatus: t.stage, err: t.err };
  }

  async getSignaturesForAddress(address: string, opts: { limit: number; commitment: "confirmed" | "finalized" }) {
    this.guard("getSignaturesForAddress");
    return (this.byAddress.get(address) ?? [])
      .map((signature) => ({ signature, t: this.txs.get(signature)! }))
      .filter(({ t }) => ORDER.indexOf(t.stage) >= ORDER.indexOf(opts.commitment))
      .reverse()
      .slice(0, opts.limit)
      .map(({ signature, t }) => ({ signature, err: t.err, slot: t.rpc.slot }));
  }

  async getLatestBlockhash() {
    this.guard("getLatestBlockhash");
    this.blockHeight += 1;
    return {
      blockhash: bs58.encode(Buffer.alloc(32, (this.blockHeight % 250) + 1)),
      lastValidBlockHeight: this.blockHeight + 150,
    };
  }

  async sendRawTransaction(base64: string) {
    this.guard("sendRawTransaction");
    const tx = Transaction.from(Buffer.from(base64, "base64"));
    return this.submit(tx, { sendAsIs: true });
  }

  // ------------------------------------------------------------ simulation

  /**
   * Submits a transaction (already signed by everyone required). Applies
   * program semantics for ProjectFunding instructions, records the tx in
   * real getTransaction json shape. Returns its signature.
   */
  submit(tx: Transaction, opts: { sendAsIs?: boolean; fail?: boolean } = {}): string {
    this.sendCount += 1;
    this.slot += 3;
    const signature = bs58.encode(tx.signature!);
    const message = tx.compileMessage();
    const keys = message.accountKeys.map((k) => k.toBase58());

    let apply: (() => void) | undefined;
    let err: unknown | null = opts.fail ? { InstructionError: [0, { Custom: 6001 }] } : null;

    if (!err) {
      for (const ix of tx.instructions) {
        if (!ix.programId.equals(this.programId)) continue;
        const disc = Buffer.from(ix.data.subarray(0, 8));
        if (disc.equals(Buffer.from(INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR))) {
          const binding = Uint8Array.from(ix.data.subarray(8, 40));
          const customer = new PublicKey(ix.data.subarray(40, 72));
          const required = ix.data.readBigUInt64LE(72);
          const pda = ix.keys[1]!.pubkey;
          const [expected, bump] = PublicKey.findProgramAddressSync([Buffer.from("pf"), Buffer.from(binding)], this.programId);
          if (!pda.equals(expected) || this.live.has(pda.toBase58())) {
            err = { InstructionError: [0, "Custom"] };
          } else {
            const st: PfState = { binding, customer, authority: ix.keys[0]!.pubkey, required, deposited: 0n, count: 0n, bump };
            this.live.set(pda.toBase58(), st);
            apply = () => this.finalizedState.set(pda.toBase58(), { ...st });
          }
        } else if (disc.equals(Buffer.from(DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR))) {
          const amount = ix.data.readBigUInt64LE(8);
          const pda = ix.keys[1]!.pubkey.toBase58();
          const st = this.live.get(pda);
          const signer = ix.keys[0]!.pubkey;
          if (!st || amount === 0n || !st.customer.equals(signer)) {
            err = { InstructionError: [0, { Custom: 2001 }] };
          } else {
            st.deposited += amount;
            st.count += 1n;
            apply = () => {
              const f = this.finalizedState.get(pda);
              if (f) {
                f.deposited += amount;
                f.count += 1n;
              }
            };
          }
        } else if (
          disc.equals(Buffer.from(SETTLE_PROJECT_FUNDING_DISCRIMINATOR)) ||
          disc.equals(Buffer.from(REFUND_PROJECT_FUNDING_DISCRIMINATOR))
        ) {
          // Phase 4E.2: authority-signed payout that closes the account.
          const settle = disc.equals(Buffer.from(SETTLE_PROJECT_FUNDING_DISCRIMINATOR));
          const pda = ix.keys[1]!.pubkey.toBase58();
          const st = this.live.get(pda);
          const customer = ix.keys[settle ? 3 : 2]!.pubkey;
          const release = settle ? ix.data.readBigUInt64LE(8) : 0n;
          if (!st || !st.authority.equals(ix.keys[0]!.pubkey) || !st.customer.equals(customer) || release > st.deposited) {
            err = { InstructionError: [0, { Custom: 2006 }] };
          } else {
            const deposited = st.deposited;
            const recipient = settle ? ix.keys[2]!.pubkey.toBase58() : null;
            this.live.delete(pda);
            apply = () => {
              this.finalizedState.delete(pda);
              if (recipient && release > 0n) this.credit(recipient, release);
              if (deposited - release > 0n) this.credit(customer.toBase58(), deposited - release);
            };
          }
        }
      }
    }

    const stage: Stage = err ? "finalized" : this.holdAtConfirmed ? "confirmed" : "finalized";
    const rpc: RpcTransaction = {
      slot: this.slot,
      blockTime: 1_790_000_000 + this.slot,
      meta: { err, innerInstructions: [] },
      transaction: {
        signatures: [signature],
        message: {
          header: { numRequiredSignatures: message.header.numRequiredSignatures },
          accountKeys: keys,
          instructions: message.instructions.map((ci) => ({
            programIdIndex: ci.programIdIndex,
            accounts: Array.from(ci.accounts),
            data: ci.data,
          })),
        },
      },
    };
    this.txs.set(signature, { rpc, stage, err, apply: err ? undefined : apply });
    for (const k of keys) {
      const list = this.byAddress.get(k) ?? [];
      list.push(signature);
      this.byAddress.set(k, list);
    }
    if (stage === "finalized") apply?.();
    return signature;
  }

  /** Moves a held transaction to finalized and applies its state change to the finalized view. */
  finalize(signature: string) {
    const t = this.txs.get(signature);
    if (!t) throw new Error("unknown signature");
    if (t.stage === "finalized") return;
    t.stage = "finalized";
    t.apply?.();
    this.slot += 32;
  }

  /** Test helper: a wallet signs the unsigned base64 transaction returned by prepare, then submits it. */
  signAndSubmit(base64: string, signer: Keypair, opts: { fail?: boolean } = {}): string {
    const tx = Transaction.from(Buffer.from(base64, "base64"));
    tx.partialSign(signer);
    return this.submit(tx, opts);
  }

  /** Test helper: places an already-initialized, already-funded account on chain (finalized), e.g. to back a DB-only funding fixture. */
  seedAccount(pda: PublicKey, st: { binding: Uint8Array; customer: PublicKey; authority: PublicKey; required: bigint; deposited: bigint }) {
    const [, bump] = PublicKey.findProgramAddressSync([Buffer.from("pf"), Buffer.from(st.binding)], this.programId);
    const state: PfState = { ...st, count: st.deposited > 0n ? 1n : 0n, bump };
    this.live.set(pda.toBase58(), state);
    this.finalizedState.set(pda.toBase58(), { ...state });
  }

  /** Test helper: raw state peek (live view). */
  peek(address: string): { deposited: bigint; count: bigint } | null {
    const st = this.live.get(address);
    return st ? { deposited: st.deposited, count: st.count } : null;
  }

  /** Test helper: a plain system transfer straight to an address (NOT a deposit). */
  systemTransfer(from: Keypair, to: PublicKey, lamports: bigint): string {
    // Built with the real SystemProgram so the tx shape is genuine.
    const tx = new Transaction({ feePayer: from.publicKey, blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 1 }).add(
      SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }),
    );
    tx.sign(from);
    return this.submit(tx);
  }
}

/** Fixed provider payout wallet for settlement tests. */
export const SETTLEMENT_RECIPIENT = Keypair.generate().publicKey;

export function makeRuntime(chain: FakeChain, authority: Keypair, requiredLamports = 50_000_000n): FundingRuntime {
  const config: FundingConfig = {
    network: "devnet",
    rpcProvider: "helius",
    rpcUrl: "https://devnet.helius-rpc.example/?api-key=SECRET-TEST-KEY",
    programId: chain.programId,
    requiredLamports,
    genesisHash: DEVNET_GENESIS_HASH,
    authorityPublicKey: authority.publicKey,
    loadAuthority: () => authority,
    settlementRecipient: SETTLEMENT_RECIPIENT,
  };
  return { config, provider: chain, pollIntervalMs: 0, sleep: async () => {} };
}
