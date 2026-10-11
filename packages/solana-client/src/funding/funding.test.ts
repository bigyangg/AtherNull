import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

import {
  BINDING_VECTORS,
  buildDepositProjectFundingIx,
  buildInitializeProjectFundingIx,
  buildRefundProjectFundingIx,
  buildSettleProjectFundingIx,
  computeBindingHash,
  decodeDepositInstructionData,
  decodeProjectFunding,
  DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR,
  deriveProjectFundingPda,
  INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR,
  PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR,
  REFUND_PROJECT_FUNDING_DISCRIMINATOR,
  SETTLE_PROJECT_FUNDING_DISCRIMINATOR,
  PROJECT_FUNDING_ACCOUNT_SIZE,
  toHex,
  uuidToBytes,
} from "../index.js";

const PROGRAM_ID = new PublicKey("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");

test("binding hash matches the shared cross-language vectors", () => {
  for (const v of BINDING_VECTORS) {
    assert.equal(toHex(computeBindingHash(v)), v.hashHex);
  }
});

test("binding hash is sensitive to each field and field order", () => {
  const base = BINDING_VECTORS[0];
  const h = toHex(computeBindingHash(base));
  assert.notEqual(
    toHex(computeBindingHash({ ...base, taskId: base.projectId, projectId: base.taskId })),
    h,
  );
  assert.notEqual(toHex(computeBindingHash({ ...base, budgetAuthorizationId: base.organizationId })), h);
});

test("uuidToBytes rejects non-canonical input", () => {
  assert.throws(() => uuidToBytes("not-a-uuid"));
  assert.throws(() => uuidToBytes("0000000000000000000000000000000100"));
  assert.equal(uuidToBytes("00000000-0000-0000-0000-000000000001").length, 16);
});

test("PDA derivation is deterministic, off-curve and seed-limit safe", () => {
  const hash = computeBindingHash(BINDING_VECTORS[0]);
  const [a, bump] = deriveProjectFundingPda(PROGRAM_ID, hash);
  const [b] = deriveProjectFundingPda(PROGRAM_ID, hash);
  assert.equal(a.toBase58(), b.toBase58());
  assert.ok(!PublicKey.isOnCurve(a.toBytes()));
  assert.ok(bump >= 0 && bump <= 255);
  const [c] = deriveProjectFundingPda(PROGRAM_ID, computeBindingHash(BINDING_VECTORS[1]));
  assert.notEqual(a.toBase58(), c.toBase58());
  assert.throws(() => deriveProjectFundingPda(PROGRAM_ID, new Uint8Array(31)));
});

test("discriminators equal the Anchor sha256 derivation", () => {
  const d = (n: string) => Uint8Array.from(createHash("sha256").update(n).digest().subarray(0, 8));
  assert.deepEqual(INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR, d("global:initialize_project_funding"));
  assert.deepEqual(DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR, d("global:deposit_project_funding"));
  assert.deepEqual(SETTLE_PROJECT_FUNDING_DISCRIMINATOR, d("global:settle_project_funding"));
  assert.deepEqual(REFUND_PROJECT_FUNDING_DISCRIMINATOR, d("global:refund_project_funding"));
  assert.deepEqual(PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR, d("account:ProjectFunding"));
});

test("discriminators match the built program IDL when one is present", () => {
  let idl: { instructions: { name: string; discriminator: number[] }[]; accounts: { name: string; discriminator: number[] }[] };
  try {
    idl = JSON.parse(
      readFileSync(new URL("../idl/athernullEscrow.json", import.meta.url), "utf8"),
    );
  } catch {
    return;
  }
  const ins = (n: string) => idl.instructions.find((i) => i.name === n);
  if (!ins("deposit_project_funding")) return; // legacy-only vendored IDL
  assert.deepEqual(ins("deposit_project_funding")!.discriminator, [...DEPOSIT_PROJECT_FUNDING_DISCRIMINATOR]);
  assert.deepEqual(ins("initialize_project_funding")!.discriminator, [...INITIALIZE_PROJECT_FUNDING_DISCRIMINATOR]);
  if (ins("settle_project_funding")) {
    assert.deepEqual(ins("settle_project_funding")!.discriminator, [...SETTLE_PROJECT_FUNDING_DISCRIMINATOR]);
    assert.deepEqual(ins("refund_project_funding")!.discriminator, [...REFUND_PROJECT_FUNDING_DISCRIMINATOR]);
  }
  assert.deepEqual(
    idl.accounts.find((a) => a.name === "ProjectFunding")!.discriminator,
    [...PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR],
  );
});

test("deposit instruction data round-trips; other data is rejected", () => {
  const customer = Keypair.generate().publicKey;
  const [pda] = deriveProjectFundingPda(PROGRAM_ID, computeBindingHash(BINDING_VECTORS[0]));
  const ix = buildDepositProjectFundingIx({ programId: PROGRAM_ID, customer, projectFunding: pda, amount: 20_000_000n });
  assert.deepEqual(decodeDepositInstructionData(bs58.encode(ix.data)), { amount: 20_000_000n });
  assert.equal(decodeDepositInstructionData(bs58.encode(Buffer.alloc(16))), null);
  assert.equal(decodeDepositInstructionData(bs58.encode(ix.data.subarray(0, 12))), null);
  const max = buildDepositProjectFundingIx({ programId: PROGRAM_ID, customer, projectFunding: pda, amount: 2n ** 64n - 1n });
  assert.equal(decodeDepositInstructionData(max.data)?.amount, 2n ** 64n - 1n);
  assert.throws(() => buildDepositProjectFundingIx({ programId: PROGRAM_ID, customer, projectFunding: pda, amount: 2n ** 64n }));
});

test("initialize instruction layout and account decode", () => {
  const authority = Keypair.generate().publicKey;
  const customer = Keypair.generate().publicKey;
  const hash = computeBindingHash(BINDING_VECTORS[1]);
  const [pda] = deriveProjectFundingPda(PROGRAM_ID, hash);
  const ix = buildInitializeProjectFundingIx({
    programId: PROGRAM_ID, authority, projectFunding: pda, bindingHash: hash, customer, requiredAmount: 50_000_000n,
  });
  assert.equal(ix.data.length, 8 + 32 + 32 + 8);
  assert.equal(ix.keys[0]!.isSigner, true);

  const raw = Buffer.alloc(PROJECT_FUNDING_ACCOUNT_SIZE);
  Buffer.from(PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR).copy(raw, 0);
  raw.writeUInt8(1, 8);
  Buffer.from(hash).copy(raw, 9);
  customer.toBuffer().copy(raw, 41);
  authority.toBuffer().copy(raw, 73);
  raw.writeBigUInt64LE(50_000_000n, 105);
  raw.writeBigUInt64LE(20_000_000n, 113);
  raw.writeBigUInt64LE(2n, 121);
  raw.writeUInt8(254, 129);
  const acc = decodeProjectFunding(raw);
  assert.equal(acc.customer.toBase58(), customer.toBase58());
  assert.equal(acc.authority.toBase58(), authority.toBase58());
  assert.equal(acc.requiredAmount, 50_000_000n);
  assert.equal(acc.depositedAmount, 20_000_000n);
  assert.equal(acc.depositCount, 2n);
  assert.equal(acc.bump, 254);
  assert.equal(toHex(acc.bindingHash), toHex(hash));
  assert.throws(() => decodeProjectFunding(raw.subarray(0, 129)));
  raw[0] = 0;
  assert.throws(() => decodeProjectFunding(raw));
});

test("settle/refund instructions carry the IDL account order and u64 release amount", () => {
  const authority = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const customer = Keypair.generate().publicKey;
  const [pda] = deriveProjectFundingPda(PROGRAM_ID, computeBindingHash(BINDING_VECTORS[0]));
  const settle = buildSettleProjectFundingIx({ programId: PROGRAM_ID, authority, projectFunding: pda, recipient, customer, releaseAmount: 50_000_000n });
  assert.deepEqual(settle.keys.map((k) => k.pubkey.toBase58()), [authority, pda, recipient, customer].map((k) => k.toBase58()));
  assert.deepEqual(settle.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true], [false, true], [false, true]]);
  assert.deepEqual([...settle.data.subarray(0, 8)], [...SETTLE_PROJECT_FUNDING_DISCRIMINATOR]);
  assert.equal(settle.data.readBigUInt64LE(8), 50_000_000n);
  const refund = buildRefundProjectFundingIx({ programId: PROGRAM_ID, authority, projectFunding: pda, customer });
  assert.deepEqual(refund.keys.map((k) => k.pubkey.toBase58()), [authority, pda, customer].map((k) => k.toBase58()));
  assert.deepEqual([...refund.data], [...REFUND_PROJECT_FUNDING_DISCRIMINATOR]);
});
