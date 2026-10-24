import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PaymentProviderCapabilitySchema,
  UnsupportedPaymentOperationError,
  assertPaymentOperationSupported,
  supportsPaymentOperation,
} from "./payments";

const capabilities = [
  PaymentProviderCapabilitySchema.parse({
    provider: "solana",
    mode: "BUILD_ESCROW",
    operations: ["QUOTE", "COLLECT", "CONFIRM", "RELEASE", "REFUND", "RECONCILE"],
  }),
  PaymentProviderCapabilitySchema.parse({
    provider: "x402",
    mode: "METERED_REQUEST",
    operations: ["QUOTE", "COLLECT", "CONFIRM", "RECONCILE"],
  }),
];

test("capability check requires a matching provider, mode, and operation", () => {
  assert.equal(supportsPaymentOperation(capabilities, "solana", "BUILD_ESCROW", "RELEASE"), true);
  assert.equal(supportsPaymentOperation(capabilities, "x402", "METERED_REQUEST", "COLLECT"), true);
  assert.equal(supportsPaymentOperation(capabilities, "x402", "BUILD_ESCROW", "COLLECT"), false);
});

test("unsupported operations fail explicitly instead of implying provider parity", () => {
  assert.throws(
    () => assertPaymentOperationSupported(capabilities, "x402", "METERED_REQUEST", "REFUND"),
    (error: unknown) =>
      error instanceof UnsupportedPaymentOperationError &&
      error.provider === "x402" &&
      error.mode === "METERED_REQUEST" &&
      error.operation === "REFUND",
  );
});

test("unknown payment operations are rejected", () => {
  assert.throws(() =>
    PaymentProviderCapabilitySchema.parse({
      provider: "x402",
      mode: "METERED_REQUEST",
      operations: ["CHARGE"],
    }),
  );
});
