import {
  type PaymentMode,
  type PaymentOperation,
  type PaymentProviderCapability,
  type PaymentProviderId,
  assertPaymentOperationSupported,
} from "@athernull/contracts";

export interface PaymentOperationContext {
  mode: PaymentMode;
  idempotencyKey: string;
  input: unknown;
}

export type PaymentOperationHandler = (context: PaymentOperationContext) => Promise<unknown>;

export interface PaymentProviderAdapter {
  provider: PaymentProviderId;
  capabilities: readonly PaymentProviderCapability[];
  operations: Partial<Record<PaymentOperation, PaymentOperationHandler>>;
}

export class PaymentProviderUnavailableError extends Error {
  constructor(readonly provider: PaymentProviderId) {
    super(`Payment provider "${provider}" is not configured`);
    this.name = "PaymentProviderUnavailableError";
  }
}

export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<PaymentProviderId, PaymentProviderAdapter>;

  constructor(providers: readonly PaymentProviderAdapter[]) {
    const registered = new Map<PaymentProviderId, PaymentProviderAdapter>();
    for (const provider of providers) {
      if (registered.has(provider.provider)) {
        throw new Error(`Payment provider "${provider.provider}" is registered more than once`);
      }
      if (provider.capabilities.some((capability) => capability.provider !== provider.provider)) {
        throw new Error(`Payment provider "${provider.provider}" declares another provider's capabilities`);
      }
      registered.set(provider.provider, provider);
    }
    this.providers = registered;
  }

  async execute(
    providerId: PaymentProviderId,
    mode: PaymentMode,
    operation: PaymentOperation,
    context: Omit<PaymentOperationContext, "mode">,
  ): Promise<unknown> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new PaymentProviderUnavailableError(providerId);

    assertPaymentOperationSupported(provider.capabilities, providerId, mode, operation);

    const handler = provider.operations[operation];
    if (!handler) {
      throw new Error(
        `Payment provider "${providerId}" declares ${operation} for ${mode} without an implementation`,
      );
    }
    return handler({ ...context, mode });
  }
}
