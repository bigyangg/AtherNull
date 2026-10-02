// Phase 4E.1 — project funding service (ADR-0013).
//
// Trust model:  Solana state -> Helius RPC transport -> THIS verification
// logic -> funding state. Helius saying "funded" is never a shortcut; every
// credit is backed by (a) a FINALIZED transaction whose single AtherNull
// instruction is a decoded deposit_project_funding for the expected PDA by
// the bound customer signer, AND (b) the finalized ProjectFunding account's
// own deposited_amount being consistent with the credited ledger. Direct
// system transfers to the PDA are never counted.
//
// Nothing in this file touches executions/tasks status: creating an account,
// preparing, depositing and verifying all have zero execution side effects.
// Only POST /v1/jobs/:id/fund (the activation gate) can queue a task.

import {
  buildDepositProjectFundingIx,
  buildInitializeProjectFundingIx,
  computeBindingHash,
  decodeProjectFunding,
  deriveProjectFundingPda,
  toHex,
} from "@athernull/solana-client";
import type { Database } from "@athernull/database";
import type { ProjectFundingView, PrepareFundingResponse, VerifyFundingResponse } from "@athernull/contracts";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Kysely, Selectable } from "kysely";

import { db } from "../db.js";
import { HttpError } from "../session.js";
import { assertTaskProvenanceChain } from "../task-provenance-check.js";
import { parseDepositTransaction } from "./deposit-parse.js";
import { FundingError, SolanaRpcError } from "./errors.js";
import type { Commitment, RpcAccount } from "./provider.js";
import { assertDevnetChain, type FundingRuntime } from "./runtime.js";
import type { ProjectFundingAccountsTable } from "@athernull/database";

type FundingRow = Selectable<ProjectFundingAccountsTable>;

/** How recent a finalized-chain verification must be for the activation gate. */
export const MAX_VERIFICATION_AGE_MS = 5 * 60_000;
export const MAX_DEPOSIT_LAMPORTS = 1_000_000_000n; // 1 devnet SOL sanity cap per deposit
const RECONCILE_LIMIT = 20;
const INIT_RETRY_AFTER_MS = 90_000; // ~blockhash lifetime
const INIT_POLL_ATTEMPTS = 12;
const SIGNATURE_VERIFY_ATTEMPTS = 3;

export function computeFundingStatus(confirmed: bigint, required: bigint) {
  if (confirmed <= 0n) return "AWAITING_FUNDS" as const;
  if (confirmed < required) return "PARTIALLY_FUNDED" as const;
  return "FUNDED" as const;
}

// ---------------------------------------------------------------- views

export async function toFundingView(row: FundingRow, conn: Kysely<Database> = db): Promise<ProjectFundingView> {
  const deposits = await conn
    .selectFrom("project_funding_deposits")
    .select(["signature", "amount_base_units", "slot", "verified_at"])
    .where("funding_account_id", "=", row.id)
    .orderBy("slot", "asc")
    .orderBy("created_at", "asc")
    .execute();
  return {
    id: row.id,
    taskId: row.task_id,
    network: "devnet",
    asset: "DEVNET_SOL",
    status: row.status as ProjectFundingView["status"],
    requiredLamports: row.required_amount_base_units,
    confirmedLamports: row.confirmed_amount_base_units,
    requirementSource: "DEMO_FIXED",
    programId: row.program_id,
    onchainAccount: row.onchain_account,
    customerWallet: row.customer_wallet,
    initialized: row.initialized_at !== null,
    initSignature: row.init_signature,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    deposits: deposits.map((d) => ({
      signature: d.signature,
      amountLamports: d.amount_base_units,
      slot: d.slot,
      verifiedAt: d.verified_at.toISOString(),
    })),
  };
}

export async function loadFundingByTask(taskId: string, organizationId: string): Promise<FundingRow | undefined> {
  return db
    .selectFrom("project_funding_accounts")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

// ---------------------------------------------------------------- create

export async function createFundingAccount(
  rt: FundingRuntime,
  args: { taskId: string; organizationId: string; userId: string },
): Promise<{ row: FundingRow; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    // Everything is derived server-side from the persisted task; the client
    // supplies only the task id in the URL.
    const task = await trx
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", args.taskId)
      .where("organization_id", "=", args.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!task) throw new HttpError(404, "Not found");

    const existing = await trx
      .selectFrom("project_funding_accounts")
      .selectAll()
      .where("task_id", "=", task.id)
      .executeTakeFirst();
    if (existing) return { row: existing, created: false };

    if (task.status !== "AWAITING_FUNDING") {
      throw new HttpError(409, `Task is ${task.status}, not AWAITING_FUNDING`);
    }
    await assertTaskProvenanceChain(trx, task);

    const bindingHash = computeBindingHash({
      organizationId: task.organization_id,
      projectId: task.project_id,
      taskId: task.id,
      budgetAuthorizationId: task.source_budget_authorization_id!,
    });
    const [pda] = deriveProjectFundingPda(rt.config.programId, bindingHash);

    const row = await trx
      .insertInto("project_funding_accounts")
      .values({
        organization_id: task.organization_id,
        project_id: task.project_id,
        task_id: task.id,
        budget_authorization_id: task.source_budget_authorization_id!,
        network: "devnet",
        rpc_provider: "helius",
        asset_type: "DEVNET_SOL",
        program_id: rt.config.programId.toBase58(),
        onchain_account: pda.toBase58(),
        binding_hash: Buffer.from(bindingHash),
        requirement_source: "DEMO_FIXED",
        required_amount_base_units: rt.config.requiredLamports.toString(),
        created_by: args.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row, created: true };
  });
}

// ---------------------------------------------------------------- state validation

function validateAccountState(row: FundingRow, rt: FundingRuntime, account: RpcAccount) {
  if (account.owner !== row.program_id) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "ProjectFunding account is not owned by the AtherNull program");
  }
  let decoded;
  try {
    decoded = decodeProjectFunding(account.data);
  } catch {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "Account data is not a ProjectFunding account");
  }
  if (toHex(decoded.bindingHash) !== Buffer.from(row.binding_hash).toString("hex")) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain binding hash does not match this funding account");
  }
  if (!row.customer_wallet || decoded.customer.toBase58() !== row.customer_wallet) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain customer does not match the bound wallet");
  }
  if (!decoded.authority.equals(rt.config.authorityPublicKey)) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain authority is not the AtherNull platform authority");
  }
  if (decoded.requiredAmount.toString() !== row.required_amount_base_units) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain required amount differs from the snapshotted requirement");
  }
  return decoded;
}

async function readAccount(rt: FundingRuntime, row: FundingRow, commitment: Commitment) {
  const info = await rt.provider.getAccountInfo(row.onchain_account, commitment);
  return info;
}

async function loadRow(id: string): Promise<FundingRow> {
  return db.selectFrom("project_funding_accounts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

// ---------------------------------------------------------------- prepare

async function bindCustomerWallet(
  rt: FundingRuntime,
  args: { taskId: string; organizationId: string; customerWallet: string },
): Promise<FundingRow> {
  let pk: PublicKey;
  try {
    pk = new PublicKey(args.customerWallet);
  } catch {
    throw new FundingError("WALLET_CONFLICT", "customerWallet is not a valid Solana address");
  }
  if (!PublicKey.isOnCurve(pk.toBytes()) || pk.equals(PublicKey.default)) {
    throw new FundingError("WALLET_CONFLICT", "customerWallet must be a wallet (signing) address");
  }
  const wallet = pk.toBase58();

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("project_funding_accounts")
      .selectAll()
      .where("task_id", "=", args.taskId)
      .where("organization_id", "=", args.organizationId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new FundingError("NO_FUNDING_ACCOUNT", "Create the project funding account first");
    const task = await trx
      .selectFrom("tasks")
      .select(["status"])
      .where("id", "=", row.task_id)
      .executeTakeFirstOrThrow();
    if (task.status !== "AWAITING_FUNDING") {
      throw new HttpError(409, `Task is ${task.status}, not AWAITING_FUNDING`);
    }
    if (row.customer_wallet === null) {
      return trx
        .updateTable("project_funding_accounts")
        .set({ customer_wallet: wallet, customer_bound_at: new Date(), version: row.version + 1 })
        .where("id", "=", row.id)
        .where("customer_wallet", "is", null)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (row.customer_wallet !== wallet) {
      throw new FundingError("WALLET_CONFLICT", "A different customer wallet is already bound to this funding account");
    }
    return row;
  });
}

async function markInitialized(rowId: string) {
  await db
    .updateTable("project_funding_accounts")
    .set({ initialized_at: new Date() })
    .where("id", "=", rowId)
    .where("initialized_at", "is", null)
    .where("init_signature", "is not", null)
    .execute();
}

/** Ensures the on-chain ProjectFunding exists for the bound customer. Returns READY or INITIALIZING. */
async function ensureOnchainAccount(rt: FundingRuntime, rowIn: FundingRow): Promise<"READY" | "INITIALIZING"> {
  const existing = await readAccount(rt, rowIn, "confirmed");
  if (existing.value) {
    validateAccountState(rowIn, rt, existing.value);
    const fresh = await loadRow(rowIn.id);
    if (fresh.init_signature === null) {
      throw new FundingError("INCONSISTENT_STATE", "On-chain account exists but no initialize attempt was recorded");
    }
    await markInitialized(rowIn.id);
    return "READY";
  }

  const authority = rt.config.loadAuthority();
  if (!authority.publicKey.equals(rt.config.authorityPublicKey)) {
    throw new FundingError("FUNDING_NOT_CONFIGURED", "SOLANA_AUTHORITY_KEYPAIR does not match SOLANA_AUTHORITY_PUBKEY");
  }

  // Claim an initialize attempt BEFORE sending, so concurrent prepares never
  // double-send and never initialize with different customers (the customer
  // was bound and committed before this point, and is immutable).
  const fresh = await loadRow(rowIn.id);
  const { blockhash, lastValidBlockHeight } = await rt.provider.getLatestBlockhash("confirmed");
  const ix = buildInitializeProjectFundingIx({
    programId: rt.config.programId,
    authority: authority.publicKey,
    projectFunding: new PublicKey(fresh.onchain_account),
    bindingHash: Uint8Array.from(fresh.binding_hash),
    customer: new PublicKey(fresh.customer_wallet!),
    requiredAmount: BigInt(fresh.required_amount_base_units),
  });
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.sign(authority);
  const signature = bs58.encode(tx.signature!);

  const cutoff = new Date(Date.now() - INIT_RETRY_AFTER_MS);
  const claimed = await db
    .updateTable("project_funding_accounts")
    .set({ init_signature: signature, init_sent_at: new Date() })
    .where("id", "=", fresh.id)
    .where("initialized_at", "is", null)
    .where((eb) => eb.or([eb("init_sent_at", "is", null), eb("init_sent_at", "<", cutoff)]))
    .returning("id")
    .executeTakeFirst();

  let activeSignature = signature;
  if (claimed) {
    try {
      await rt.provider.sendRawTransaction(tx.serialize().toString("base64"));
    } catch (err) {
      await db
        .updateTable("project_funding_accounts")
        .set({ init_signature: null, init_sent_at: null })
        .where("id", "=", fresh.id)
        .where("init_signature", "=", signature)
        .where("initialized_at", "is", null)
        .execute();
      if (err instanceof SolanaRpcError && !err.retriable) {
        throw new FundingError(
          "FUNDING_NOT_CONFIGURED",
          "The on-chain initialize was rejected by the RPC (is the devnet authority wallet funded and the program deployed?)",
        );
      }
      throw err;
    }
  } else {
    // Another request owns the in-flight attempt; just wait on its signature.
    activeSignature = (await loadRow(fresh.id)).init_signature ?? signature;
  }

  for (let i = 0; i < INIT_POLL_ATTEMPTS; i++) {
    const st = await rt.provider.getSignatureStatus(activeSignature);
    if (st?.err) {
      await db
        .updateTable("project_funding_accounts")
        .set({ init_signature: null, init_sent_at: null })
        .where("id", "=", fresh.id)
        .where("init_signature", "=", activeSignature)
        .where("initialized_at", "is", null)
        .execute();
      throw new FundingError("TX_FAILED", "On-chain initialize transaction failed");
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      const info = await readAccount(rt, fresh, "confirmed");
      if (info.value) {
        validateAccountState(fresh, rt, info.value);
        await markInitialized(fresh.id);
        return "READY";
      }
    }
    await rt.sleep(rt.pollIntervalMs);
  }
  return "INITIALIZING";
}

export async function prepareFunding(
  rt: FundingRuntime,
  args: { taskId: string; organizationId: string; customerWallet: string; amountLamports?: string },
): Promise<PrepareFundingResponse> {
  const bound = await bindCustomerWallet(rt, args);
  await assertDevnetChain(rt);

  const state = await ensureOnchainAccount(rt, bound);
  const row = await loadRow(bound.id);
  const funding = await toFundingView(row);
  if (state === "INITIALIZING") return { funding, state, transaction: null };

  const required = BigInt(row.required_amount_base_units);
  const confirmed = BigInt(row.confirmed_amount_base_units);
  let amount: bigint;
  if (args.amountLamports !== undefined) {
    amount = BigInt(args.amountLamports);
  } else {
    amount = required - confirmed;
    if (amount <= 0n) throw new FundingError("ALREADY_FUNDED", "The funding requirement is already met");
  }
  if (amount <= 0n || amount > MAX_DEPOSIT_LAMPORTS) {
    throw new FundingError("BAD_AMOUNT", "Deposit must be between 1 lamport and 1 devnet SOL");
  }

  const { blockhash, lastValidBlockHeight } = await rt.provider.getLatestBlockhash("confirmed");
  const customer = new PublicKey(row.customer_wallet!);
  const ix = buildDepositProjectFundingIx({
    programId: rt.config.programId,
    customer,
    projectFunding: new PublicKey(row.onchain_account),
    amount,
  });
  const tx = new Transaction({ feePayer: customer, blockhash, lastValidBlockHeight }).add(ix);
  return {
    funding,
    state: "READY",
    transaction: {
      base64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      amountLamports: amount.toString(),
      lastValidBlockHeight,
    },
  };
}

// ---------------------------------------------------------------- verify

type SigOutcome = NonNullable<VerifyFundingResponse["signature"]>;

async function ledgerSum(conn: Kysely<Database>, fundingId: string): Promise<bigint> {
  const r = await conn
    .selectFrom("project_funding_deposits")
    .select((eb) => eb.fn.sum<string>("amount_base_units").as("total"))
    .where("funding_account_id", "=", fundingId)
    .executeTakeFirst();
  return BigInt(r?.total ?? "0");
}

class RetryRead extends Error {}

async function verifySignature(rt: FundingRuntime, row: FundingRow, signature: string): Promise<SigOutcome> {
  if (!row.customer_wallet) throw new FundingError("WALLET_NOT_BOUND", "No customer wallet is bound to this funding account");

  const dup = await db
    .selectFrom("project_funding_deposits")
    .select(["funding_account_id"])
    .where("signature", "=", signature)
    .executeTakeFirst();
  if (dup) {
    if (dup.funding_account_id !== row.id) {
      throw new FundingError("INCONSISTENT_STATE", "Signature is already credited to a different funding account");
    }
    return { signature, outcome: "ALREADY_CREDITED", observedCommitment: "finalized" };
  }

  // FINALIZED only: getTransaction at "finalized" returns null until then.
  const tx = await rt.provider.getTransaction(signature, "finalized");
  if (!tx) {
    const st = await rt.provider.getSignatureStatus(signature);
    if (st?.err) throw new FundingError("TX_FAILED", "Transaction failed on chain");
    return { signature, outcome: "PENDING", observedCommitment: st?.confirmationStatus ?? null };
  }

  const parsed = parseDepositTransaction(tx, {
    signature,
    programId: row.program_id,
    projectFunding: row.onchain_account,
    customer: row.customer_wallet,
  });

  for (let attempt = 0; attempt < SIGNATURE_VERIFY_ATTEMPTS; attempt++) {
    const acct = await readAccount(rt, row, "finalized");
    if (!acct.value) throw new FundingError("ACCOUNT_STATE_MISMATCH", "Finalized ProjectFunding account not found");
    if (acct.slot < tx.slot) return { signature, outcome: "PENDING", observedCommitment: "finalized" };
    const decoded = validateAccountState(row, rt, acct.value);

    try {
      return await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom("project_funding_accounts")
          .selectAll()
          .where("id", "=", row.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const before = await ledgerSum(trx, row.id);
        // The program's deposited_amount is authoritative: the credited
        // ledger may never exceed it.
        if (before + parsed.amount > decoded.depositedAmount) {
          // A concurrent verify may have credited a deposit newer than our
          // account snapshot; re-read the account before declaring a fault.
          throw new RetryRead();
        }
        const inserted = await trx
          .insertInto("project_funding_deposits")
          .values({
            funding_account_id: row.id,
            signature,
            amount_base_units: parsed.amount.toString(),
            depositor_wallet: parsed.customer,
            slot: String(tx.slot),
            block_time: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
            commitment: "finalized",
          })
          .onConflict((oc) => oc.column("signature").doNothing())
          .returning("id")
          .executeTakeFirst();
        if (!inserted) return { signature, outcome: "ALREADY_CREDITED" as const, observedCommitment: "finalized" as const };

        const total = before + parsed.amount;
        const status = computeFundingStatus(total, BigInt(locked.required_amount_base_units));
        const priorSlot = locked.last_verified_slot ? BigInt(locked.last_verified_slot) : 0n;
        const slot = BigInt(acct.slot) > priorSlot ? BigInt(acct.slot) : priorSlot;
        await trx
          .updateTable("project_funding_accounts")
          .set({
            confirmed_amount_base_units: total.toString(),
            status,
            funded_at: status === "FUNDED" ? (locked.funded_at ?? new Date()) : null,
            verified_at: new Date(),
            last_verified_slot: slot.toString(),
            last_verified_commitment: "finalized",
            version: locked.version + 1,
          })
          .where("id", "=", row.id)
          .execute();
        return { signature, outcome: "CREDITED" as const, observedCommitment: "finalized" as const };
      });
    } catch (err) {
      if (err instanceof RetryRead) continue;
      throw err;
    }
  }
  throw new FundingError(
    "INCONSISTENT_STATE",
    "Credited deposits would exceed the finalized on-chain deposited_amount; refusing to credit",
  );
}

/** Reads the finalized account, checks it against the ledger, and stamps verification freshness. */
async function refreshFromChain(rt: FundingRuntime, row: FundingRow): Promise<void> {
  if (!row.customer_wallet) throw new FundingError("WALLET_NOT_BOUND", "No customer wallet is bound to this funding account");
  const acct = await readAccount(rt, row, "finalized");
  if (!acct.value) {
    // Account not (yet) finalized on chain: nothing can have been credited.
    const sum = await ledgerSum(db, row.id);
    if (sum > 0n) throw new FundingError("INCONSISTENT_STATE", "Deposits are credited but the finalized account was not found");
    return;
  }
  const decoded = validateAccountState(row, rt, acct.value);

  const sum = await ledgerSum(db, row.id);
  if (sum > decoded.depositedAmount) {
    throw new FundingError("INCONSISTENT_STATE", "Credited deposits exceed the finalized on-chain deposited_amount");
  }

  // Missing credits (deposit made, signature never submitted): discover them
  // from the PDA's finalized history, bounded.
  if (decoded.depositedAmount > sum) {
    const sigs = await rt.provider.getSignaturesForAddress(row.onchain_account, {
      limit: RECONCILE_LIMIT,
      commitment: "finalized",
    });
    for (const s of sigs) {
      if (s.err !== null && s.err !== undefined) continue;
      if (s.signature === row.init_signature) continue;
      try {
        await verifySignature(rt, row, s.signature);
      } catch (err) {
        // A non-deposit (e.g. a direct system transfer) simply isn't a
        // credit; RPC faults still propagate (fail closed).
        if (err instanceof FundingError && err.status === 422) continue;
        throw err;
      }
    }
  }

  const fresh = await loadRow(row.id);
  const slot = BigInt(acct.slot);
  const prior = fresh.last_verified_slot ? BigInt(fresh.last_verified_slot) : 0n;
  await db
    .updateTable("project_funding_accounts")
    .set({
      verified_at: new Date(),
      last_verified_slot: (slot > prior ? slot : prior).toString(),
      last_verified_commitment: "finalized",
    })
    .where("id", "=", row.id)
    .execute();
}

export async function verifyFunding(
  rt: FundingRuntime,
  args: { taskId: string; organizationId: string; signature?: string },
): Promise<VerifyFundingResponse> {
  const row = await loadFundingByTask(args.taskId, args.organizationId);
  if (!row) throw new FundingError("NO_FUNDING_ACCOUNT", "Create the project funding account first");
  await assertDevnetChain(rt);

  let outcome: SigOutcome | null = null;
  if (args.signature) outcome = await verifySignature(rt, row, args.signature);
  await refreshFromChain(rt, await loadRow(row.id));

  return { funding: await toFundingView(await loadRow(row.id)), signature: outcome };
}

/**
 * Activation-gate freshness refresh (called by POST /fund before its
 * transaction when the last verification is stale). Re-reads the finalized
 * account; any RPC fault propagates (fail closed -> 503, never QUEUED).
 */
export async function refreshFundingForGate(rt: FundingRuntime, row: FundingRow): Promise<void> {
  await assertDevnetChain(rt);
  await refreshFromChain(rt, row);
}
