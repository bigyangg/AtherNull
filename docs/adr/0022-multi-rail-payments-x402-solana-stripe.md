# ADR-0022: Multi-rail payments with x402-first metering and escrow preservation

Status: Proposed
Date: 2026-10-24

## Context

AtherNull currently uses Solana devnet escrow flow for fund/settle/refund tied to build outcomes.
Product direction now requires:

1. Keep Solana support.
2. Add x402 support as a first-class payment option.
3. Add Stripe after Solana+x402.
4. Maintain compatibility with current escrow-anchored trust model.

x402 is well-suited to metered/pay-per-request service payments, while full build engagements in
AtherNull require milestone-like hold/release semantics with acceptance and refund branches.

## Decision

1. **Introduce a Payment Provider abstraction** in API domain logic:
   provider contract includes `quote`, `authorize_or_fund`, `confirm`, `release`, `refund`, and
   `reconcile` operations, with idempotency and immutable ledger event recording.

2. **Preserve escrow-style flow for full builds**:
   - full build commitments continue to require held funds before tool-enabled execution;
   - settlement/refund decisions remain bound to verification + acceptance policy.

3. **Adopt x402 first for metered service payments and eligible build funding modes**:
   - initial x402 scope: verification/metered endpoints and org-configurable funded operations;
   - funds are recognized only after provider-specific finality confirmation rules.

4. **Keep Solana as existing provider implementation**:
   - Solana provider remains default where escrow contract semantics are required.

5. **Stripe deferred but pre-modeled**:
   - API and ledger schema reserve provider-neutral fields and lifecycle states;
   - Stripe implementation added after Solana+x402 stabilization.

6. **Provider routing policy**:
   - organization/project policy declares allowed providers and preferred order;
   - fallback between providers is explicit, audited, and never implicit on partial failures.

## Consequences

- Allows broader payment flexibility without discarding current trust and payout model.
- Enables x402-based agentic/metered monetization that aligns with API-native usage.
- Adds complexity in payment state modeling, reconciliation, and observability.
- Requires clear UX communication so users understand provider capabilities and refund semantics.
- Reduces lock-in and prepares staged Stripe rollout without reworking core money state.
