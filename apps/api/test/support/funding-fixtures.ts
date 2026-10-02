// FIXTURE-ONLY helper for test files whose subject is NOT funding (job
// lifecycle, OpenHands compat, realtime, tenant authorization, ...). Those
// tests historically called POST /fund to get a task to QUEUED when /fund was
// a stub. /fund is now the real activation gate, so they seed a FUNDED,
// freshly-verified project_funding_accounts row directly in the database —
// there is deliberately NO environment/flag bypass in production code.
//
// Funding behaviour itself is tested in project-funding*.test.ts against the
// real service with a deterministic chain double.

import { createHash, randomBytes } from "node:crypto";

import { computeBindingHash, deriveProjectFundingPda } from "@athernull/solana-client";
import { Keypair, PublicKey } from "@solana/web3.js";

import { db } from "../../src/db.js";

// Activation-gate policy reads SOLANA_NETWORK; fixtures run in "devnet" mode.
process.env.SOLANA_NETWORK ??= "devnet";

export const FIXTURE_PROGRAM_ID = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");

/** Inserts a FUNDED, freshly verified funding row (+ one finalized deposit) for an AWAITING_FUNDING task. */
export async function seedFundedFunding(taskId: string): Promise<void> {
  const task = await db.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirstOrThrow();
  if (!task.source_budget_authorization_id) throw new Error("seedFundedFunding needs a canonical (provenance-bound) task");
  const bindingHash = computeBindingHash({
    organizationId: task.organization_id,
    projectId: task.project_id,
    taskId: task.id,
    budgetAuthorizationId: task.source_budget_authorization_id,
  });
  const [pda] = deriveProjectFundingPda(FIXTURE_PROGRAM_ID, bindingHash);
  const project = await db.selectFrom("projects").select(["owner_user_id"]).where("id", "=", task.project_id).executeTakeFirstOrThrow();
  const wallet = Keypair.generate().publicKey.toBase58();
  const row = await db
    .insertInto("project_funding_accounts")
    .values({
      organization_id: task.organization_id,
      project_id: task.project_id,
      task_id: task.id,
      budget_authorization_id: task.source_budget_authorization_id,
      network: "devnet",
      rpc_provider: "helius",
      asset_type: "DEVNET_SOL",
      program_id: FIXTURE_PROGRAM_ID.toBase58(),
      onchain_account: pda.toBase58(),
      binding_hash: Buffer.from(bindingHash),
      customer_wallet: wallet,
      customer_bound_at: new Date(),
      requirement_source: "DEMO_FIXED",
      required_amount_base_units: "50000000",
      confirmed_amount_base_units: "50000000",
      status: "FUNDED",
      init_signature: "fixture-init",
      init_sent_at: new Date(),
      initialized_at: new Date(),
      created_by: project.owner_user_id,
      funded_at: new Date(),
      verified_at: new Date(),
      last_verified_slot: "1",
      last_verified_commitment: "finalized",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("project_funding_deposits")
    .values({
      funding_account_id: row.id,
      signature: `fixture-${createHash("sha256").update(randomBytes(8)).digest("hex")}`,
      amount_base_units: "50000000",
      depositor_wallet: wallet,
      slot: "1",
      commitment: "finalized",
    })
    .execute();
}
