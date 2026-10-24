import { z } from "zod";

// ADR-0022 — capability vocabulary shared by payment-domain code. This
// describes operations a provider may support; it does not enable a provider
// or assert that its payment semantics match another provider's.
export const PaymentProviderIdSchema = z.enum(["solana", "x402", "stripe"]);
export type PaymentProviderId = z.infer<typeof PaymentProviderIdSchema>;

export const PaymentModeSchema = z.enum(["BUILD_ESCROW", "METERED_REQUEST"]);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

export const PaymentOperationSchema = z.enum([
  "QUOTE",
  "COLLECT",
  "CONFIRM",
  "RELEASE",
  "REFUND",
  "RECONCILE",
]);
export type PaymentOperation = z.infer<typeof PaymentOperationSchema>;

export const PaymentProviderCapabilitySchema = z.object({
  provider: PaymentProviderIdSchema,
  mode: PaymentModeSchema,
  operations: z.array(PaymentOperationSchema),
});
export type PaymentProviderCapability = z.infer<typeof PaymentProviderCapabilitySchema>;

export class UnsupportedPaymentOperationError extends Error {
  constructor(
    readonly provider: PaymentProviderId,
    readonly mode: PaymentMode,
    readonly operation: PaymentOperation,
  ) {
    super(`Payment provider "${provider}" does not support ${operation} for ${mode}`);
    this.name = "UnsupportedPaymentOperationError";
  }
}

export function supportsPaymentOperation(
  capabilities: readonly PaymentProviderCapability[],
  provider: PaymentProviderId,
  mode: PaymentMode,
  operation: PaymentOperation,
): boolean {
  return capabilities.some(
    (capability) =>
      capability.provider === provider &&
      capability.mode === mode &&
      capability.operations.includes(operation),
  );
}

export function assertPaymentOperationSupported(
  capabilities: readonly PaymentProviderCapability[],
  provider: PaymentProviderId,
  mode: PaymentMode,
  operation: PaymentOperation,
): void {
  if (!supportsPaymentOperation(capabilities, provider, mode, operation)) {
    throw new UnsupportedPaymentOperationError(provider, mode, operation);
  }
}
