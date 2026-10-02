import assert from "node:assert/strict";
import { test } from "node:test";

import {
  devnetExplorerAddressUrl,
  devnetExplorerTxUrl,
  formatDevnetSol,
  PrepareFundingRequestSchema,
  VerifyFundingRequestSchema,
} from "./project-funding";

test("explorer links are devnet-scoped only", () => {
  assert.equal(
    devnetExplorerAddressUrl("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv"),
    "https://explorer.solana.com/address/9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv?cluster=devnet",
  );
  assert.match(devnetExplorerTxUrl("abc"), /\?cluster=devnet$/);
});

test("lamports format as devnet SOL with integer math (no float)", () => {
  assert.equal(formatDevnetSol("0"), "0.00");
  assert.equal(formatDevnetSol("50000000"), "0.05");
  assert.equal(formatDevnetSol("80000000"), "0.08");
  assert.equal(formatDevnetSol("1234567890"), "1.23456789");
  assert.equal(formatDevnetSol(18_446_744_073_709_551_615n), "18446744073.709551615");
});

test("prepare request accepts a wallet address and integer lamports only", () => {
  const w = "AMWem7ejFqbAna11U8BGxckyRWH2LdKWs6rA75LDAwFb";
  assert.ok(PrepareFundingRequestSchema.safeParse({ customerWallet: w }).success);
  assert.ok(PrepareFundingRequestSchema.safeParse({ customerWallet: w, amountLamports: "20000000" }).success);
  assert.ok(!PrepareFundingRequestSchema.safeParse({ customerWallet: w, amountLamports: "0.02" }).success);
  assert.ok(!PrepareFundingRequestSchema.safeParse({ customerWallet: w, amountLamports: "0" }).success);
  assert.ok(!PrepareFundingRequestSchema.safeParse({ customerWallet: "not-base58-0OIl" }).success);
});

test("verify request signature must look like a base58 signature", () => {
  assert.ok(VerifyFundingRequestSchema.safeParse({}).success);
  assert.ok(!VerifyFundingRequestSchema.safeParse({ signature: "short" }).success);
});
