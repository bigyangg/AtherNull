# Chat payment API contract

Status: Proposed. Existing `/v1` conventions apply: Better Auth session cookie, active org from the session, zod validation, `{ error }` bodies, camelCase JSON, money as **integer base-unit strings**, Origin check on mutations.
Related: [ESCROW_STATE_MACHINE.md](ESCROW_STATE_MACHINE.md).

## 0. Conventions

- **Roles:** `member` (any org member), `privileged` (org owner/admin), `staff` (new platform staff role, not an org role), `worker`/`verifier` (internal tokens), `system` (reconciler / projector, no HTTP).
- **Idempotency:** every mutation below accepts an `Idempotency-Key` header (UUID). It's stored in `api_idempotency_keys(org, key, route, request_sha256, response)`. A repeat with the same body returns the stored response; a repeat with a different body returns `409 IDEMPOTENCY_CONFLICT`.
- **Optimistic concurrency:** actions on a plan or invoice name the exact `planId` and `version` (or `invoiceId`). A stale id returns `409 STALE` with the current head.
- **Money:** `{ amount: "12500000", currency: "USDC", decimals: 6 }`. Floats never appear.
- **Errors:** `400 VALIDATION`, `401`, `403 FORBIDDEN`, `404`, `409 STALE | CONFLICT | IDEMPOTENCY_CONFLICT | INVALID_TRANSITION`, `422 UNPRICEABLE`, `429`, `502 PLANNER | RPC`, `503 NOT_CONFIGURED`.

## 1. Conversation timeline (new)

| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | `/v1/conversations/:conversationId/timeline?after=<cursor>` | member | AtherNull events for one discussion, oldest first, paginated |
| GET (SSE) | `/v1/conversations/:conversationId/timeline/stream?after=<cursor>` | member | Live tail of the same events; resumes from the cursor |

The conversation must be a `discussion_conversations` row of the caller's org and not `deleted_at`. Otherwise the response is 404.

Event envelope (`conversation_events` row):

```json
{
  "id": "evt_…", "cursor": "000123", "conversationId": "…", "type": "PLAN_GENERATED",
  "occurredAt": "2026-10-12T10:00:00Z",
  "refs": { "projectId": "…", "planId": "…", "lineageId": "…", "version": 2, "invoiceId": null, "taskId": null, "executionId": null },
  "payload": { }
}
```

Event types and payloads. Every payload is a snapshot; the card re-reads the authoritative resource before acting.

| Type | Payload (summary) |
|---|---|
| `PLAN_GENERATED` | plan summary, version, `pricingStatus`, quote total if priced |
| `PLAN_REVISED` | `fromVersion`, `toVersion`, changes summary |
| `PLAN_APPROVED` / `PLAN_REJECTED` | version, actor, reason |
| `INVOICE_ISSUED` | invoice id, line items, total, expiry |
| `PAYMENT_PENDING` | signature, observed commitment |
| `PAYMENT_FINALIZED` | signature, slot, amount |
| `PAYMENT_PROBLEM` | code (`EXPIRED`, `TX_FAILED`, `STRAY_TOKENS`) |
| `BUILD_QUEUED` / `BUILD_STARTED` | task id, execution id, attempt |
| `MILESTONE_COMPLETED` | milestone index, title (from plan) |
| `BUILD_FAILED` | attempt, retrying? |
| `VERIFICATION_PASSED` / `VERIFICATION_FAILED` | test counts, report link |
| `DELIVERY_READY` | preview link, review window end |
| `DISPUTE_OPENED` / `DISPUTE_RESOLVED` | reason, split |
| `SETTLEMENT_COMPLETED` | kind (`RELEASED`/`REFUNDED`), signature |

Only `system` writes events: the projector, the plan and invoice services, and the reconciler. **No endpoint lets a client create a timeline event.**

## 2. Plan actions

Existing routes are reused where possible. New behaviour is marked ★.

| Method | Route | Role | Body | Result |
|---|---|---|---|---|
| POST ★ | `/v1/conversations/:conversationId/plans` | member | `{}` (the transcript is read server-side) | `201` plan v1 (new lineage). With an `Idempotency-Key`, or if the discussion already has an active lineage, returns that lineage's head (`200`), not a duplicate. Project: an existing `conversation_projects` link, or a new **hosted** project created lazily (no repository needed for planning). |
| POST | `/v1/projects/:p/estimates/:e/revise` (★ changed) | member | `{ request: string ≤ 4000 }` | `201` new version. The planner input is the original requirements + previous plan JSON + change request + constraints (fixes audit B2). Rejected when `:e` isn't the head (409 STALE) or is APPROVED with an issued invoice (409). |
| POST | `/v1/projects/:p/estimates/:e/approve` | privileged | `{ version: number }` (★ must match) | `200` approved. ★ On success, issues the invoice in the same transaction (section 3). |
| POST ★ | `/v1/projects/:p/estimates/:e/reject` | privileged | `{ reason?: string ≤ 1000 }` | `200` REJECTED. Only `READY_FOR_REVIEW` heads; no invoice can follow. The conversation stays usable; a new plan can be drafted. |

The Builds-page routes (`POST /v1/projects/:p/estimates` with `discussionId`) keep working and get the same idempotency guard.

## 3. Quotes and invoices

| Method | Route | Role | Purpose |
|---|---|---|---|
| GET ★ | `/v1/invoices/:invoiceId` | member | Invoice snapshot, line items, status, escrow refs |
| GET ★ | `/v1/conversations/:conversationId/invoices` | member | Invoices for the discussion |
| POST ★ | `/v1/invoices/:invoiceId/cancel` | privileged | `ISSUED` / `AWAITING_PAYMENT` only, and only before any deposit is seen |
| POST ★ | `/v1/staff/invoices/:invoiceId/quote` | staff | Manual quote for `REVIEW_REQUIRED` (line items and reason), audit-logged |

Issuing happens on approve. One transaction does all of this:
1. Compute the quote with the active `pricing_rate_cards` version. If it's unpriceable, the invoice is `REVIEW_REQUIRED` and approval still succeeds.
2. Insert `project_invoices` (ISSUED) and the line items, with `plan_content_sha256`.
3. Insert `project_budget_authorizations` (`source='INVOICE'`, amount = total).
4. Insert the task (`AWAITING_FUNDING`) through the existing provenance code, with `tasks.invoice_id` unique.
5. Insert the funding account row (USDC, `invoice_id` unique).
6. Emit `INVOICE_ISSUED`.

On-chain `initialize` runs **after** commit, from the outbox (`ESCROW_INIT_REQUESTED`), so RPC never runs inside a DB transaction. That's the same rule as today.

**No route marks an invoice paid. No route queues a build.**

## 4. Wallet checkout

| Method | Route | Role | Body | Result |
|---|---|---|---|---|
| POST ★ | `/v1/invoices/:invoiceId/payment/prepare` | privileged | `{ customerWallet: base58 }` | Binds the wallet (immutable, as today) and returns the unsigned `deposit` transaction (base64) with `recentBlockhash`, `lastValidBlockHeight`, and a human summary (amount, mint, escrow, network). 409 unless `AWAITING_PAYMENT`. |
| POST ★ | `/v1/invoices/:invoiceId/payment/submitted` | privileged | `{ signature }` | **Hint only.** Records the signature for the reconciler to check first, and returns the current status. It never credits anything by itself. |
| GET ★ | `/v1/invoices/:invoiceId/payment` | member | | Status: `AWAITING_PAYMENT`/`VERIFYING`/`FUNDED`/… plus the deposit (signature, slot, commitment) |
| POST ★ | `/v1/invoices/:invoiceId/payment/reconcile` | privileged | `{}` | Asks for an immediate reconciliation pass (rate-limited to 1 per 10 s per invoice). Same code path as the background job. |

The existing `/v1/jobs/:id/funding*` and `/v1/jobs/:id/fund` stay for **legacy SOL tasks only**. For a USDC task, `/fund` returns `409 AUTO_ACTIVATED`.

## 5. Delivery, acceptance, disputes

| Method | Route | Role | Purpose |
|---|---|---|---|
| GET | `/v1/jobs/:id/patch` (★ restricted) | member | Preview only (diff + report) until `RELEASED` |
| POST | `/v1/jobs/:id/accept` (★ changed) | privileged | For USDC tasks: returns the unsigned customer `accept` transaction to sign. The reconciler observes the finalized result. |
| POST ★ | `/v1/jobs/:id/dispute` | privileged | `{ reason }`: returns the unsigned customer `dispute` transaction; records the reason |
| POST | `/v1/jobs/:id/reject` | privileged | Legacy SOL only. For USDC tasks: `409 USE_DISPUTE`. |
| POST | `/v1/jobs/:id/refund` | privileged | Legacy SOL only. USDC refunds are operator or arbiter actions. |
| POST | `/v1/jobs/:id/verify` (★ restricted) | **staff** | Incident override; requires `reason`; audit event; never on USDC tasks in `DELIVERED` or later |
| POST ★ | `/v1/staff/disputes/:taskId/resolve` | staff (arbiter co-signers) | `{ releaseBps, rationale }`: builds the arbiter transaction for multisig signing |

## 6. Internal and system flows (no public route)

| Flow | Trigger | Guarantees |
|---|---|---|
| Payment reconciler | Every 15 s, plus `payment/submitted` and `payment/reconcile` hints | Reads escrows with status in (`AWAITING_PAYMENT`, `VERIFYING`) via `getSignaturesForAddress(vault)` and `getAccountInfo(escrow, finalized)`. Credits once (unique signature). In the same transaction: invoice `FUNDED`, task `AWAITING_FUNDING → QUEUED` (provenance re-checked), outbox `BUILD_QUEUED` + timeline events. |
| Outbox dispatcher | `outbox_events` with `FOR UPDATE SKIP LOCKED` | At-least-once delivery; consumers are idempotent by `(event_id)` |
| Escrow operator | Outbox (`ESCROW_INIT_REQUESTED`, `DELIVERY_RECORD_REQUESTED`, `RELEASE_DUE`, `REFUND_REQUESTED`) | Signs with the operator key; finality is tracked like `settlement-service.ts` today |
| Timeline projector | `execution_events`, task status changes, verifier results | Writes typed `conversation_events` for `tasks.invoice_id → invoices.conversation_id` |
| Consistency checker | Every 5 min | Alerts on: FUNDED invoice without a QUEUED-or-later task after 2 min; escrow on-chain state different from the DB; stray tokens; outbox rows older than 5 min |

## 7. Transition permissions summary

| Transition | member | privileged | staff | worker | verifier | system |
|---|---|---|---|---|---|---|
| Draft / revise plan | ✓ | ✓ | | | | |
| Approve / reject plan | | ✓ | | | | |
| Issue invoice | | (via approve) | quote only | | | ✓ |
| Mark invoice funded | | | | | | ✓ (finalized chain only) |
| Queue build | | | | | | ✓ |
| Claim / complete execution | | | | ✓ | | |
| PASS / FAIL | | | override with audit | | ✓ | |
| Record delivery | | | | | | ✓ (operator key) |
| Accept / dispute | | ✓ (wallet signs) | | | | |
| Resolve dispute | | | ✓ (arbiter multisig) | | | |
| Release after review window | | | | | | ✓ |
| Refund before delivery | | | ✓ | | | ✓ (failed or cancelled build) |
