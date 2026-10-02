# ADR-0013: Solana devnet project funding and the activation gate (Phase 4E.1)

Status: Implemented, pending review and real-devnet verification
Date: 2026-10-02

## Context

After Phase 4C a provenance-bound task reaches `AWAITING_FUNDING`, but
`POST /v1/jobs/:id/fund` was a stub: it wrote a `chain: 'stub'`
`payment_intents` row and queued the task. Phase 4E.1 makes the funding
prerequisite real, on **Solana devnet with test value only**, before any
execution starts.

## Decision

### Scope

- **Solana devnet only.** Mainnet, testnet and unknown networks fail closed.
- **`DEVNET_SOL`** (integer lamports). No SPL token: it would add a mint
  authority, ATAs and decimals without stronger semantics, because the program
  tracks `deposited_amount` itself.
- No settlement, refund, pricing, FX, provider payout or real customer money.
  Those are Phase 4E.2 and later.

### Trust model

```
Solana state -> Helius RPC transport -> AtherNull verification logic -> funding state
```

- **Solana is the source of truth.** Helius is only the RPC transport
  (standard JSON-RPC; no enhanced APIs, no webhooks, no fallback provider).
  "Helius said funded" is never a shortcut.
- Verification is owned by `apps/api`. The worker/OpenHands agent has no RPC
  access and no wallet/key authority. The Helius URL (it carries the API key)
  and the platform authority secret live only in `apps/api`'s environment and
  never reach the browser, the worker, logs, error messages, task prompts,
  OpenHands events or execution metadata.

### Network policy (fail closed)

- `SOLANA_NETWORK` must be exactly `devnet` (checked by config loading and by
  the activation gate on every call). Mainnet-beta, testnet, unknown and unset
  are rejected.
- Chain identity is **not** inferred from the RPC hostname: before verifying,
  `getGenesisHash` must equal Solana devnet's genesis hash
  (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`, cross-checked against
  `api.devnet.solana.com` during implementation). A mismatch is never cached.
- `network`, `rpc_provider` and `asset_type` are persisted explicitly and
  CHECK-constrained to `devnet` / `helius` / `DEVNET_SOL`.

### Funding requirement is not a budget

`required_amount_base_units` is `DEMO_FIXED`, snapshotted at account creation
from `SOLANA_DEMO_REQUIRED_LAMPORTS` (default 50,000,000 lamports = 0.05 devnet
SOL). It is **not** derived from `project_budget_authorizations.amount_minor`,
NIM usage, USD or a SOL price, and `amount_minor` is never equated with
lamports. Current NIM usage remains unpriced. No USD equivalent is shown.

### Program: `ProjectFunding` PDA

The existing `athernull_escrow` program is extended **additively**; the legacy
escrow instructions are untouched and unused until Phase 4E.2 supersedes them.

`ProjectFunding` (PDA seeds `["pf", binding_hash]`, 130 bytes with the
Anchor discriminator): `version`, `binding_hash`, `customer`, `authority`,
`required_amount`, `deposited_amount`, `deposit_count`, `bump`.

- `initialize_project_funding(binding_hash, customer, required_amount)` —
  signed by the platform authority (who pays rent). Only that signer can
  create an account, so on-chain state is trustworthy by construction.
  Duplicate initialization is impossible (`init`).
- `deposit_project_funding(amount)` — signed by the bound `customer`
  (`has_one`). `amount > 0`; `checked_add` on both counters; CPI system
  transfer.
- `deposited_amount` is the authoritative funding state. A plain system
  transfer to the PDA changes lamports but **never** `deposited_amount`.

### Provenance binding

```
binding_hash = SHA-256( "athernull:project-funding:v1" || 0x01
                        || organization UUID (16 raw bytes)
                        || project UUID (16 raw bytes)
                        || task UUID (16 raw bytes)
                        || budget authorization UUID (16 raw bytes) )
```

No JSON, no string seeds; the 32-byte hash fits Solana's per-seed limit
exactly. TypeScript (`packages/solana-client`) and Rust (the program's state
tests) compute identical hashes against shared vectors. All four IDs are
derived server-side from the persisted task; the client supplies only the task
id.

### Database

`0013_project_funding.sql` adds `project_funding_accounts` and
`project_funding_deposits`. `payment_intents` is **not** reused (historical
legacy state; its rows are not migrated or fabricated, and `/fund` no longer
writes the stub row).

The database itself enforces:
- composite FK `(task_id, project_id, organization_id)` -> exact task;
- composite FK `(task_id, budget_authorization_id)` -> `tasks (id,
  source_budget_authorization_id)`, i.e. the task's own authorization;
- one account per task, one per authorization, unique `binding_hash` and PDA;
- `network = 'devnet'`, `asset_type = 'DEVNET_SOL'`, integer lamports, status
  as a pure function of the amounts;
- immutability of identity/provenance/requirement columns and of a bound
  `customer_wallet` (trigger); confirmed amount can never decrease;
- an append-only deposit ledger with `UNIQUE(signature)`.

### Customer wallet binding

`customer_wallet` starts NULL. `POST .../funding/prepare` locks the row
(`FOR UPDATE`): NULL binds the supplied on-chain-valid wallet address; an
equal wallet continues idempotently; a different wallet is `409`. Once bound it
is immutable, and the on-chain initialize (sent only after the bind commits)
always names the bound customer. An initialize attempt is claimed in the
database before sending, so concurrent prepares never double-send or
initialize with different customers.

### Deposit verification (finalized-only, instruction-decoded)

Credit is **never** derived from a lamport delta. For each submitted signature
`apps/api`:
1. fetches the transaction at **`finalized`** (processed/confirmed are shown as
   progress only and credit nothing);
2. requires `meta.err == null`, the signature to match, and **exactly one**
   top-level instruction addressed to the AtherNull program (other programs'
   instructions are allowed; any CPI into the program is rejected);
3. decodes it as `deposit_project_funding` and reads the amount from the
   instruction data;
4. requires its accounts to be the expected PDA and the bound customer, who
   must be a signer;
5. reads and decodes the **finalized** `ProjectFunding` account (owner,
   binding hash, customer, authority, required amount all must match) and
   requires the credited ledger to be consistent with its
   `deposited_amount`;
6. inserts the deposit idempotently and recomputes status.

Phase 4E.1 accepts exactly one deposit instruction per transaction, so
`UNIQUE(signature)` is the deposit identity and re-verification cannot
double-credit. Deposits made without a submitted signature are discovered from
the PDA's finalized history (bounded) when on-chain `deposited_amount` exceeds
the ledger.

Statuses: `AWAITING_FUNDS` (0), `PARTIALLY_FUNDED` (0 < deposited < required),
`FUNDED` (>= required). Partial, multiple and over-funding are supported; the
actual deposited amount is preserved and nothing is refunded in 4E.1.

### Failure semantics

RPC timeout, 429, 5xx and unreachable endpoints return a retriable
`503 VERIFICATION_UNAVAILABLE`; funding is never assumed and the task is never
activated. Retries are bounded (3 attempts, exponential backoff with jitter,
`Retry-After` honoured and capped, 15s total budget, 8s per call) and never
loop inside one HTTP request. "Not visible yet" is a `PENDING` outcome, not an
error; failed transactions, wrong program/PDA/customer and insufficient amount
are distinct.

### Activation gate

`POST /v1/jobs/:id/fund` keeps its route (UI label: **Activate Build**). After
every Phase 4C provenance check (now shared via `assertTaskProvenanceChain`),
inside the same transaction it locks the funding row and requires: network
`devnet`, status `FUNDED`, confirmed >= required, task/org/project/budget
authorization match, and a finalized-chain verification no older than 5
minutes (stale verifications are refreshed from chain first; an RPC fault
fails closed). Only then `AWAITING_FUNDING -> QUEUED`, guarded by the existing
status+version optimistic update, so concurrent activations yield one
transition. There is no environment/flag bypass. Creating an account, preparing,
depositing and verifying all have zero execution side effects (a static test,
like the 4A/4B/4C ones, enforces that the funding sources never touch
executions, QUEUED, claim or dispatch).

### Authority model

| Authority | Holder | Use |
|---|---|---|
| User wallet | browser wallet | signs deposits only; private keys are never collected |
| Platform authority | devnet keypair, `apps/api` env only | signs `initialize` only (4E.1); future settlement/refund authority |
| Program upgrade authority | operator's deploy wallet | deployment only, never in the API |
| Worker / OpenHands | none | no keys, no RPC access |

Platform-authority custody beyond devnet is out of scope; the program is
unaudited.

### Client packaging

`packages/solana-client` now exposes a thin, Anchor-free surface (binding hash,
PDA derivation, constants, account decode, instruction build/decode) on
`@solana/web3.js` + `bs58`. The Anchor-based legacy client moved to
`@athernull/solana-client/legacy-escrow` and Anchor is an optional peer /
dev dependency; neither `apps/api` nor `apps/web` depends on the Anchor runtime.
`apps/web` adds only `@solana/wallet-adapter-react` and `@solana/web3.js` and
uses the public devnet endpoint solely so the wallet knows which chain to sign
for.

### Frontend

Customer wording: Project Funding, Fund Project, Awaiting funding, Partially
funded, Funded, Activate Build. The network is always labelled Solana Devnet,
no USD equivalent is shown, the word "Escrow" is not used (4E.2), and Explorer
links are devnet-scoped only. This intentionally lifts the earlier
"no Fund/Pay/Deposit wording" rule for the funding panel alone.

## Testing

- Rust unit tests (binding vectors, deposit arithmetic incl. overflow) and
  13 Anchor integration tests plus the legacy suite on a local validator.
- API/Postgres tests with a chain double that implements **only** the RPC
  transport; the verification logic is not mocked.
- A local-validator API test runs the real service against the real program
  with real JSON-RPC shapes (skipped unless `SOLANA_LOCAL_VALIDATOR_URL` is
  set; the harness injects the validator's own genesis hash, never an env
  override).
- Automated tests never depend on live devnet or Helius.

## Consequences and known limitations

- The platform authority key sits in the API environment (devnet only).
- Finalized-only credit costs ~13-15s of devnet latency versus `confirmed`.
- Devnet resets, faucet limits and Helius free-tier rate limits apply; a
  wallet blockhash expires in roughly 60-90s.
- A dropped on-chain initialize is retried after ~90s.
- Webhooks are deferred; verification is explicit/polled.

## Phase 4E.2 boundary

Acceptance-triggered settlement, unused-value return/refund, account closeout,
settlement idempotency and explorer proof, failed/rejected/disputed build
behavior, mapping usage to a settlement amount (a pricing decision), and
removal of the legacy escrow instructions.
