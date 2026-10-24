# ADR-0022: Multi-rail payments with x402-first metering and escrow preservation

Status: Accepted for architecture; provider rollout is gated
Date: 2026-10-24

## Context

AtherNull currently uses Solana devnet funding and settlement for build outcomes.
The funding account must be finalized and verified before tool-enabled execution;
settlement or refund follows verification and customer acceptance/rejection
(ADR-0013 and ADR-0014).

The product direction is to retain Solana, add x402 for metered payments, and
consider Stripe after Solana and x402 are stable. These rails do not have
equivalent payment semantics. In particular, an x402 request payment is not a
hold that can be released or refunded according to a later build decision.

## Decision

### Provider capabilities and scope

Provider contracts expose capabilities, not an assumption that every provider
implements the same lifecycle:

| Provider | Initial capability | Build escrow | Metered request charge |
|---|---|---:|---:|
| Solana | Existing project-funding escrow | Yes, devnet only | No |
| x402 | One-shot request payment | No | Planned |
| Stripe | Deferred; capabilities to be evaluated | Not enabled | Not enabled |

An operation unsupported by a provider must fail explicitly. A provider must
not report a one-shot charge as held funds, or claim release/refund semantics
that it does not provide.

The existing build funding, activation, settlement, and refund paths remain on
Solana. No x402 or Stripe payment may satisfy the build activation gate. The
first x402 candidate is a separately identified, customer-facing paid
verification/metered operation. It is not the usage-summary read endpoint,
worker/internal routes, or a build-funding mode. No such endpoint is billable
until the gates below are met.

### Pricing and rollout gates

`apps/api/src/pricing/rates.ts` currently has no configured rate card, and
usage events remain `UNPRICED`. Therefore the API must not charge for usage or
verification, and payment amounts must never be inferred from token counts,
budget authorizations, or client-supplied values.

Before enabling x402, a separate decision and implementation must specify:

- the exact billable endpoint and customer-visible price/units;
- the accepted network and asset, including the asset identifier/address;
- the facilitator or settlement authority and how its result is independently
  trusted;
- what constitutes confirmed payment/finality and how pending, failed, and
  ambiguous settlements are handled;
- request/payment idempotency and replay protection, including the retention
  period for deduplication evidence;
- reconciliation, provider outages, and the supported refund/dispute process.

Until then, x402 remains disabled and no provider/network/asset is implicitly
selected. Stripe remains deferred until x402 is stable and its authorization,
capture, refund, and dispute semantics have been separately decided.

### Ledgers and provider selection

- `project_funding_accounts`, `project_funding_deposits`, and
  `project_funding_settlements` remain the authoritative Solana build-funding
  records. Their finalized-chain checks and immutable decisions are unchanged.
- `payment_intents` is historical legacy state. It is not reused or migrated
  into a provider-neutral ledger.
- A provider-specific x402 payment ledger and its relationship to any future
  shared payment event model must be designed with the x402 integration. It
  must preserve provider evidence, tenant attribution, idempotency, and
  append-only audit history; it must not duplicate or replace Solana's current
  source-of-truth ledgers.
- Provider selection must be explicit and auditable. No automatic fallback is
  allowed after a request may have been paid or its outcome is ambiguous.
  Organization/project provider policy is not active until its allowed
  providers and customer-facing behavior are specified.

## Consequences

- Solana build escrow retains its existing trust model and behavior.
- x402 can be added for one-shot metered operations without implying escrow,
  build activation, or guaranteed refunds.
- No payments are enabled by this ADR alone. Missing pricing and settlement
  decisions are intentional release blockers, not defaults for implementers to
  guess.
- A capability-aware API and ledger design is required before provider
  implementations are routed through common domain logic.
- Stripe and cross-provider routing remain later work; provider fallback must
  never obscure partial or uncertain payment outcomes.

## Validation before rollout

Tests must cover payment replay/duplicate requests, pending and failed
confirmation, ambiguous provider outcomes and reconciliation, tenant
isolation, and explicit rejection of unsupported operations. Existing Solana
finalized funding, activation, settlement, refund, and recovery tests must
continue to pass unchanged.
