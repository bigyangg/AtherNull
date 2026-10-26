import assert from "node:assert/strict";
import { test } from "node:test";

import type { PaymentProviderCapability } from "@athernull/contracts";

import {
  PaymentProviderRegistry,
  PaymentProviderUnavailableError,
} from "../src/payments/provider-registry.js";

const x402MeteredCapabilities: PaymentProviderCapability[] = [
  { provider: "x402", mode: "METERED_REQUEST", operations: ["QUOTE", "COLLECT", "CONFIRM"] },
];

test("executes only the explicitly selected provider and passes the requested mode", async () => {
  let called = false;
  const registry = new PaymentProviderRegistry([
    {
      provider: "x402",
      capabilities: x402MeteredCapabilities,
      operations: {
        COLLECT: async (context) => {
          called = true;
          return { provider: "x402", mode: context.mode, key: context.idempotencyKey };
        },
      },
    },
  ]);

  const result = await registry.execute("x402", "METERED_REQUEST", "COLLECT", {
    idempotencyKey: "request-1",
    input: {},
  });
  assert.deepEqual(result, { provider: "x402", mode: "METERED_REQUEST", key: "request-1" });
  assert.equal(called, true);
});

test("does not fall back when the explicitly selected provider is unavailable", async () => {
  let solanaCalled = false;
  const registry = new PaymentProviderRegistry([
    {
      provider: "solana",
      capabilities: [
        { provider: "solana", mode: "BUILD_ESCROW", operations: ["COLLECT"] },
      ],
      operations: { COLLECT: async () => (solanaCalled = true) },
    },
  ]);

  await assert.rejects(
    registry.execute("x402", "METERED_REQUEST", "COLLECT", {
      idempotencyKey: "request-1",
      input: {},
    }),
    PaymentProviderUnavailableError,
  );
  assert.equal(solanaCalled, false);
});

test("rejects unsupported operations and providers that claim unimplemented operations", async () => {
  const registry = new PaymentProviderRegistry([
    {
      provider: "x402",
      capabilities: x402MeteredCapabilities,
      operations: {},
    },
  ]);

  await assert.rejects(
    registry.execute("x402", "METERED_REQUEST", "REFUND", {
      idempotencyKey: "request-1",
      input: {},
    }),
    /does not support REFUND/,
  );
  await assert.rejects(
    registry.execute("x402", "METERED_REQUEST", "COLLECT", {
      idempotencyKey: "request-1",
      input: {},
    }),
    /declares COLLECT .* without an implementation/,
  );
});

test("rejects duplicate provider registrations and mismatched capabilities", () => {
  const x402 = {
    provider: "x402" as const,
    capabilities: x402MeteredCapabilities,
    operations: {},
  };
  assert.throws(() => new PaymentProviderRegistry([x402, x402]), /registered more than once/);
  assert.throws(
    () =>
      new PaymentProviderRegistry([
        {
          ...x402,
          capabilities: [{ provider: "solana", mode: "BUILD_ESCROW", operations: ["COLLECT"] }],
        },
      ]),
    /declares another provider's capabilities/,
  );
});
