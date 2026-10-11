// Phase 4E.2 — settlement (accepted build) and refund (rejected/failed
// build) of a ProjectFunding account. See
// docs/adr/0014-devnet-settlement-and-refund.md.
//
// Split of responsibility, same as 4E.1: this file owns the chain side and
// the project_funding_settlements ledger only. It never changes a task's
// status — routes/jobs.ts decides to settle/refund (inside the task's own
// transaction, via insertSettlement) and moves the task to SETTLED/REFUNDED
// only after checkSettlementFinality reports FINALIZED.
//
// Payout transactions are authority-signed and close the on-chain account,
// so a funding account can be paid out at most once on chain; the UNIQUE
// funding_account_id row is the matching guarantee in Postgres. Every send
// is claimed in the database first (signature persisted before sending), so
// concurrent drivers never double-send, and a lost send is retried only
// after its blockhash has expired.

import {
  REFUND_PROJECT_FUNDING_DISCRIMINATOR,
  SETTLE_PROJECT_FUNDING_DISCRIMINATOR,
  buildRefundProjectFundingIx,
  buildSettleProjectFundingIx,
  decodeProjectFunding,
} from "@athernull/solana-client";
import type { Database, ProjectFundingAccountsTable, ProjectFundingSettlementsTable } from "@athernull/database";
import type { ProjectFundingSettlementView } from "@athernull/contracts";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Kysely, Selectable, Transaction as DbTransaction } from "kysely";

import { db } from "../db.js";
import { FundingError, SolanaRpcError } from "./errors.js";
import type { RpcTransaction } from "./provider.js";
import { assertDevnetChain, type FundingRuntime } from "./runtime.js";

type FundingRow = Selectable<ProjectFundingAccountsTable>;
type SettlementRow = Selectable<ProjectFundingSettlementsTable>;
export type SettlementKind = "SETTLE" | "REFUND";

const RESEND_AFTER_MS = 90_000; // ~blockhash lifetime
const CONFIRM_POLL_ATTEMPTS = 12;
const DISCOVERY_LIMIT = 20;

// ------------------------------------------------------------------ views

export function toSettlementView(row: SettlementRow): ProjectFundingSettlementView {
  return {
    kind: row.kind as SettlementKind,
    status: row.status as ProjectFundingSettlementView["status"],
    releaseLamports: row.release_amount_base_units,
    refundLamports: row.refund_amount_base_units,
    recipientWallet: row.recipient_wallet,
    customerWallet: row.customer_wallet,
    signature: row.signature,
    finalizedAt: row.finalized_at ? row.finalized_at.toISOString() : null,
  };
}

export async function loadSettlementByTask(
  taskId: string,
  organizationId: string,
  conn: Kysely<Database> = db,
): Promise<SettlementRow | undefined> {
  return conn
    .selectFrom("project_funding_settlements")
    .selectAll()
    .where("task_id", "=", taskId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

// --------------------------------------------------------------- decision

// DEMO_FIXED pricing, consistent with 4E.1's DEMO_FIXED requirement: an
// accepted build releases the funding requirement to the provider and
// returns any over-funding to the customer; a refund returns everything.
// No usage-to-lamports mapping exists (usage is unpriced).
export function computeSettlementAmounts(
  kind: SettlementKind,
  confirmed: bigint,
  required: bigint,
): { release: bigint; refund: bigint } {
  if (kind === "REFUND") return { release: 0n, refund: confirmed };
  const release = confirmed < required ? confirmed : required;
  return { release, refund: confirmed - release };
}

/**
 * Records the settle/refund decision for a task's funding account inside the
 * caller's transaction (the same one that moves the task to SETTLING /
 * REFUNDING). Returns null when the task has no confirmed on-chain deposit,
 * i.e. there is nothing to pay out.
 */
export async function insertSettlement(
  trx: DbTransaction<Database>,
  args: { taskId: string; organizationId: string; kind: SettlementKind; userId: string; recipient: PublicKey },
): Promise<SettlementRow | null> {
  const funding = await trx
    .selectFrom("project_funding_accounts")
    .selectAll()
    .where("task_id", "=", args.taskId)
    .where("organization_id", "=", args.organizationId)
    .forUpdate()
    .executeTakeFirst();
  if (!funding || BigInt(funding.confirmed_amount_base_units) === 0n || !funding.customer_wallet) return null;

  const existing = await trx
    .selectFrom("project_funding_settlements")
    .selectAll()
    .where("funding_account_id", "=", funding.id)
    .executeTakeFirst();
  if (existing) {
    if (existing.kind !== args.kind) {
      throw new FundingError("INCONSISTENT_STATE", `This funding account is already being ${existing.kind === "SETTLE" ? "settled" : "refunded"}`);
    }
    return existing;
  }

  const { release, refund } = computeSettlementAmounts(
    args.kind,
    BigInt(funding.confirmed_amount_base_units),
    BigInt(funding.required_amount_base_units),
  );
  return trx
    .insertInto("project_funding_settlements")
    .values({
      funding_account_id: funding.id,
      organization_id: funding.organization_id,
      task_id: funding.task_id,
      kind: args.kind,
      release_amount_base_units: release.toString(),
      refund_amount_base_units: refund.toString(),
      recipient_wallet: args.kind === "SETTLE" ? args.recipient.toBase58() : null,
      customer_wallet: funding.customer_wallet,
      created_by: args.userId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// ----------------------------------------------------------------- submit

async function loadSettlement(id: string): Promise<SettlementRow> {
  return db.selectFrom("project_funding_settlements").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

async function loadFunding(id: string): Promise<FundingRow> {
  return db.selectFrom("project_funding_accounts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

function discriminatorFor(kind: SettlementKind): Uint8Array {
  return kind === "SETTLE" ? SETTLE_PROJECT_FUNDING_DISCRIMINATOR : REFUND_PROJECT_FUNDING_DISCRIMINATOR;
}

/**
 * True when `tx` is a successful transaction whose single top-level
 * AtherNull instruction is this settlement's settle/refund for this PDA.
 */
export function isPayoutTransaction(
  tx: RpcTransaction,
  expected: { programId: string; projectFunding: string; kind: SettlementKind },
): boolean {
  if (!tx.meta || (tx.meta.err !== null && tx.meta.err !== undefined)) return false;
  const msg = tx.transaction.message;
  const keys = [
    ...msg.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const ours = msg.instructions.filter((ix) => keys[ix.programIdIndex] === expected.programId);
  if (ours.length !== 1) return false;
  const ix = ours[0]!;
  let data: Uint8Array;
  try {
    data = bs58.decode(ix.data);
  } catch {
    return false;
  }
  const disc = discriminatorFor(expected.kind);
  if (data.length < 8 || !disc.every((b, i) => data[i] === b)) return false;
  return keys[ix.accounts[1]!] === expected.projectFunding;
}

// A payout landed but its signature was never recorded (e.g. the process
// died between send and persist): find it in the PDA's history.
async function discoverPayoutSignature(rt: FundingRuntime, funding: FundingRow, kind: SettlementKind): Promise<string | null> {
  const sigs = await rt.provider.getSignaturesForAddress(funding.onchain_account, {
    limit: DISCOVERY_LIMIT,
    commitment: "confirmed",
  });
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rt.provider.getTransaction(s.signature, "confirmed");
    if (tx && isPayoutTransaction(tx, { programId: rt.config.programId.toBase58(), projectFunding: funding.onchain_account, kind })) {
      return s.signature;
    }
  }
  return null;
}

/**
 * Makes sure the payout transaction for an already-decided settlement has
 * been sent (sending it at most once per blockhash lifetime) and waits
 * briefly for it to confirm. Safe to call repeatedly and concurrently.
 */
export async function submitSettlement(rt: FundingRuntime, settlementId: string): Promise<SettlementRow> {
  await assertDevnetChain(rt);
  let row = await loadSettlement(settlementId);
  if (row.status === "FINALIZED") return row;
  const funding = await loadFunding(row.funding_account_id);
  const kind = row.kind as SettlementKind;

  const fresh = row.sent_at !== null && Date.now() - new Date(row.sent_at).getTime() < RESEND_AFTER_MS;
  if (row.signature && fresh) return waitForConfirmation(rt, row);

  const account = await rt.provider.getAccountInfo(funding.onchain_account, "confirmed");
  if (!account.value) {
    // Closed: a payout already landed. Keep (or recover) its signature.
    if (row.signature) return row;
    const found = await discoverPayoutSignature(rt, funding, kind);
    if (!found) {
      throw new FundingError("INCONSISTENT_STATE", "The on-chain project account is closed but no payout transaction was found");
    }
    await db
      .updateTable("project_funding_settlements")
      .set({ signature: found, sent_at: new Date(), status: "SUBMITTED" })
      .where("id", "=", row.id)
      .where("signature", "is", null)
      .execute();
    return loadSettlement(row.id);
  }

  const state = decodeProjectFunding(account.value.data);
  const authority = rt.config.loadAuthority();
  if (!state.authority.equals(authority.publicKey) || state.customer.toBase58() !== row.customer_wallet) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain project account authority/customer does not match this settlement");
  }
  const expectedTotal = BigInt(row.release_amount_base_units) + BigInt(row.refund_amount_base_units);
  if (state.depositedAmount !== expectedTotal) {
    throw new FundingError("ACCOUNT_STATE_MISMATCH", "On-chain deposited amount differs from the settled amount");
  }

  const projectFunding = new PublicKey(funding.onchain_account);
  const customer = new PublicKey(row.customer_wallet);
  const ix =
    kind === "SETTLE"
      ? buildSettleProjectFundingIx({
          programId: rt.config.programId,
          authority: authority.publicKey,
          projectFunding,
          recipient: new PublicKey(row.recipient_wallet!),
          customer,
          releaseAmount: BigInt(row.release_amount_base_units),
        })
      : buildRefundProjectFundingIx({ programId: rt.config.programId, authority: authority.publicKey, projectFunding, customer });
  const { blockhash, lastValidBlockHeight } = await rt.provider.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  tx.sign(authority);
  const signature = bs58.encode(tx.signature!);

  // Claim before sending: only one driver sends per blockhash lifetime.
  const cutoff = new Date(Date.now() - RESEND_AFTER_MS);
  const claimed = await db
    .updateTable("project_funding_settlements")
    .set({ signature, sent_at: new Date(), status: "SUBMITTED" })
    .where("id", "=", row.id)
    .where("status", "!=", "FINALIZED")
    .where((eb) => eb.or([eb("sent_at", "is", null), eb("sent_at", "<", cutoff)]))
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return waitForConfirmation(rt, await loadSettlement(row.id));

  try {
    await rt.provider.sendRawTransaction(tx.serialize().toString("base64"));
  } catch (err) {
    await releaseClaim(row.id, signature);
    if (err instanceof SolanaRpcError && !err.retriable) {
      throw new FundingError("TX_FAILED", "The payout transaction was rejected by the RPC (is the program upgraded and the authority funded?)");
    }
    throw err;
  }
  row = claimed;
  return waitForConfirmation(rt, row);
}

async function releaseClaim(id: string, signature: string) {
  await db
    .updateTable("project_funding_settlements")
    .set({ signature: null, sent_at: null, status: "PENDING" })
    .where("id", "=", id)
    .where("signature", "=", signature)
    .where("status", "!=", "FINALIZED")
    .execute();
}

async function waitForConfirmation(rt: FundingRuntime, row: SettlementRow): Promise<SettlementRow> {
  if (!row.signature) return row;
  for (let i = 0; i < CONFIRM_POLL_ATTEMPTS; i++) {
    const st = await rt.provider.getSignatureStatus(row.signature);
    if (st?.err) {
      await releaseClaim(row.id, row.signature);
      throw new FundingError("TX_FAILED", "The payout transaction failed on chain");
    }
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
    await rt.sleep(rt.pollIntervalMs);
  }
  return loadSettlement(row.id);
}

// --------------------------------------------------------------- finality

/**
 * FINALIZED only once the payout transaction is finalized on chain and is
 * verifiably this settlement's settle/refund for this PDA. A failed or
 * vanished attempt releases the claim so the next submit re-sends.
 */
export async function checkSettlementFinality(
  rt: FundingRuntime,
  settlementId: string,
): Promise<{ status: "FINALIZED" | "PENDING"; row: SettlementRow }> {
  await assertDevnetChain(rt);
  const row = await loadSettlement(settlementId);
  if (row.status === "FINALIZED") return { status: "FINALIZED", row };
  if (!row.signature) return { status: "PENDING", row };

  const funding = await loadFunding(row.funding_account_id);
  const tx = await rt.provider.getTransaction(row.signature, "finalized");
  if (!tx) {
    const st = await rt.provider.getSignatureStatus(row.signature);
    const expired = row.sent_at !== null && Date.now() - new Date(row.sent_at).getTime() >= RESEND_AFTER_MS;
    if (st?.err || (!st && expired)) await releaseClaim(row.id, row.signature);
    return { status: "PENDING", row: await loadSettlement(row.id) };
  }
  const kind = row.kind as SettlementKind;
  if (!isPayoutTransaction(tx, { programId: rt.config.programId.toBase58(), projectFunding: funding.onchain_account, kind })) {
    if (tx.meta?.err) {
      await releaseClaim(row.id, row.signature);
      return { status: "PENDING", row: await loadSettlement(row.id) };
    }
    throw new FundingError("INCONSISTENT_STATE", "Recorded payout signature is not this settlement's transaction");
  }

  const updated = await db
    .updateTable("project_funding_settlements")
    .set({ status: "FINALIZED", finalized_at: new Date(), finalized_slot: String(tx.slot) })
    .where("id", "=", row.id)
    .where("signature", "=", row.signature)
    .where("status", "!=", "FINALIZED")
    .returningAll()
    .executeTakeFirst();
  return { status: "FINALIZED", row: updated ?? (await loadSettlement(row.id)) };
}
