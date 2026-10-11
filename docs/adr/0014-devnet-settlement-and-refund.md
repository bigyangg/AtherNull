# ADR-0014: Devnet settlement and refund of project funding (Phase 4E.2)

Status: Implemented; verified on a local validator, devnet program upgrade pending
Date: 2026-10-10

## Context

ADR-0013 (Phase 4E.1) made a build's activation depend on a verified,
finalized devnet deposit into a `ProjectFunding` PDA, and explicitly left
settlement, refund, account closeout and failed/rejected-build behavior to
4E.2. Until now `accept` and `reject` only wrote a `chain = 'stub'`
`payment_intents` row and jumped straight to `SETTLED` / `REFUNDED`, so the
deposited devnet SOL never moved.

## Decision

### Program (additive)

Two new authority-only instructions on `ProjectFunding`. Both close the
account (rent back to the authority), so a funding account can be paid out
**at most once on chain**:

- `settle_project_funding(release_amount)` — pays `release_amount` of
  `deposited_amount` to a `recipient` named by the authority and the rest of
  the deposit to the bound `customer`. `release_amount > deposited_amount`
  fails with `SettlementExceedsDeposit` (appended error code).
- `refund_project_funding()` — pays the whole `deposited_amount` to the bound
  `customer`.

Both require `has_one = authority` (`Unauthorized`) and `has_one = customer`,
so a payout can never be redirected away from the bound customer. Only
deposited value moves: lamports sent to the PDA outside
`deposit_project_funding` are not deposits and go back to the authority with
the rent on close. Existing instructions, accounts and error codes are
unchanged.

### Amounts (DEMO_FIXED, like the requirement)

Usage is still unpriced, so there is no usage-to-lamports mapping. An
accepted build releases `min(deposited, required)` to the provider and
returns any over-funding to the customer; a refund returns everything.

### Ledger and state machine

`0014_project_funding_settlements.sql`: one row per funding account
(`UNIQUE funding_account_id`, `UNIQUE task_id`), recording the decision
(`SETTLE`/`REFUND`, amounts, recipient, customer) and the payout attempt
(`PENDING -> SUBMITTED -> FINALIZED`). The decision columns are immutable,
a `FINALIZED` row is frozen, and rows are never deleted (triggers).

| Action | Task transition | Payout |
|---|---|---|
| `POST /v1/jobs/:id/accept` | `AWAITING_ACCEPTANCE -> SETTLING -> SETTLED` | settle |
| `POST /v1/jobs/:id/reject` | `AWAITING_ACCEPTANCE -> REFUNDING -> REFUNDED` | refund |
| `POST /v1/jobs/:id/refund` (new) | `FAILED`/`CANCELLED -> REFUNDING -> REFUNDED` | refund |
| `POST /v1/jobs/:id/settlement/verify` (new) | `SETTLING`/`REFUNDING` -> terminal once finalized | drives an existing decision |

The decision (task -> `SETTLING`/`REFUNDING` + ledger row) commits in one
transaction. The authority-signed payout is then sent outside it; the task
reaches `SETTLED`/`REFUNDED` **only after the payout transaction is
finalized** and decoded as this settlement's instruction for this PDA. A
chain failure after the decision leaves the task in `SETTLING`/`REFUNDING`
and `settlement/verify` resumes it — it never re-decides.

Tasks without a confirmed deposit (pre-4E.1 data) keep the legacy immediate
`accept`/`reject` path; `refund` refuses them (`NO_FUNDING_ACCOUNT`).

### Idempotency and recovery

- **Claim before send**: the signature is persisted before the transaction is
  sent; a re-send happens only after the previous attempt failed or its
  blockhash lifetime (~90s) passed with nothing on chain.
- **On-chain close** makes a second payout impossible even if the database
  were wrong.
- **Lost signature**: if the account is closed but no signature is recorded
  (crash between send and persist), the payout is discovered from the PDA's
  signature history and adopted instead of re-sent.
- RPC faults fail closed (`503`), never "settled".

### Separation (unchanged invariants)

`apps/api/src/solana/settlement-service.ts` owns the chain side and the
ledger only; it never changes a task's status (the static
`project-funding-no-execution-path` test still holds for every file under
`solana/`). Task transitions stay in `routes/jobs.ts`.

### Config

`SOLANA_SETTLEMENT_RECIPIENT` (optional): provider payout wallet; defaults
to the platform authority.

## Testing

- Rust unit test for the settlement split.
- 7 Anchor integration tests (split, over-release, wrong authority, wrong
  customer, close + no double payout, stray lamports, wire format) on a local
  validator, alongside the unchanged 4E.1 and legacy suites (26 passing).
- 10 API/Postgres tests with the chain double (settle, under-funding, delayed
  finality without re-send, RPC outage + resume, lost-signature recovery,
  reject, failed-build refund, refund guards, tenancy, DB immutability).
- The local-validator API test now accepts a funded build and refunds a
  failed one through the real program to finalized state.

## Consequences

- **Devnet requires a program upgrade** (the binary grew from 275,568 to
  296,856 bytes, so the program data account must be extended first) before
  accept/reject work against devnet funding accounts.
- Platform-authority custody is still a devnet keypair in the API
  environment; unaudited program.
- Disputes, partial (usage-based) settlement and a pricing-derived release
  amount remain future work.
