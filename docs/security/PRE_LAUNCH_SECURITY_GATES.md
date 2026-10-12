# Pre-launch security gates

Status: Proposed. Gates are cumulative: a release stage needs every gate at or below its level. Evidence means a test, a script output or a review record in the repository. A statement in a PR description doesn't count.
Related: `docs/threat-model.md` (its non-negotiable rules apply here unchanged), [../architecture/CHAT_NATIVE_MIGRATION_PLAN.md](../architecture/CHAT_NATIVE_MIGRATION_PLAN.md).

| Stage | Who can sign up | Money | Required gates |
|---|---|---|---|
| S0 Internal demo | Team only | Devnet SOL / devnet USDC | G0 |
| S1 Public devnet (hackathon judges) | Anyone | Devnet only | G0, G1 |
| S2 Real-money pilot | Invited customers | Mainnet USDC, low caps | G0–G3 + external audit |
| S3 General availability | Anyone | Mainnet USDC | All gates + incident runbooks |

## G0: Tenant and sandbox isolation (Phase 0). **Blocks S1.**

| # | Gate | Today | Evidence required |
|---|---|---|---|
| G0.1 | A customer sandbox can't reach Postgres, the API's internal routes, the Docker socket, cloud metadata (`169.254.169.254`), the host's other ports, or another org's sandbox | **Fails (Likely)**: default bridge, no egress rules (`provision.ts:109`) | Isolation test: from inside sandbox A, `nc`/`curl` against each target fails; sandbox B's port fails; allowed egress (package registries, LLM proxy) succeeds |
| G0.2 | No platform credential is readable inside a sandbox (env, settings, conversation state, files) | **Fails**: three paths (target doc V4) | Test: grep the sandbox's `/workspace`, its env and `GET /api/settings` for each provider key prefix; must find none. LLM traffic only through the proxy with scoped tokens |
| G0.3 | CPU, memory, pids and disk limits on every sandbox; one tenant can't starve the host | **Fails** | `docker inspect` assertions in a provisioning test; fork-bomb and `dd` tests stay contained |
| G0.4 | Sandbox image pinned by digest; upgrades are explicit | **Fails** (`latest-python`) | `IMAGE` contains `@sha256:`; CI check |
| G0.5 | Customers can't produce a verification outcome | **Fails** (`POST /v1/jobs/:id/verify` is owner-callable) | Tenant-authorization test: owner → 403; staff → 200 with an audit row |
| G0.6 | Sandbox session keys aren't stored in plaintext | **Fails** (`org_agent_servers.session_api_key`) | Column encrypted (AES-256-GCM, key from secret manager or env, rotated); a DB dump contains no usable key |
| G0.7 | Append-only audit log for security and financial actions | **Fails** (`audit_events` never written) | Rows written for: role-sensitive actions, verification overrides, plan approvals, invoices, payments, settlements, sandbox provisioning. The DB role used by the app can't `UPDATE`/`DELETE` it (revoke + trigger). |
| G0.8 | Gateway: browsers can't change Apps (canvas extensions) | **Passes** (uncommitted `policy.ts` change + test) | Existing policy test |
| G0.9 | Discussion agent has no tools, MCP or skills | **Passes** (`discussions.ts:53-64`) | Existing tests + a new assertion in the gateway test |

## G1: Application security (Phases 1–2). **Blocks S1 for the chat-native flow.**

| # | Gate | Evidence |
|---|---|---|
| G1.1 | Every new `/v1` route checks the org on every id it receives (conversation, plan, invoice, task) | `tenant-authorization.test.ts` extended: cross-org id → 404 for each new route |
| G1.2 | Timeline events can't be written by clients; card actions re-read authoritative state | Test: no POST route on `conversation_events`; approve with a stale version → 409 |
| G1.3 | Duplicate planning is impossible (double click, two tabs, retry) | Concurrency test: 10 parallel plan requests for one discussion → one lineage |
| G1.4 | Deleted discussions never resurface; funded work is never deleted by a chat delete | Lifecycle tests per scenario (migration plan, Phase 1) |
| G1.5 | The canvas card renderer escapes all text; no HTML from events | Patch review + XSS test strings in plan titles and reasons |

## G2: Payments and escrow (Phases 3–5). **Blocks S2.**

| # | Gate | Evidence |
|---|---|---|
| G2.1 | Adversarial Anchor test suite passes: wrong mint, wrong token program, Token-2022 mint, wrong vault, wrong authority, wrong customer source, wrong amount (±1), second deposit, late deposit, replayed accept/release/refund/resolve, operator release before delivery, operator release inside the review window, customer refund after delivery, arbiter outside a dispute, stray tokens at close, checked-math overflow, pause doesn't block exits | `contracts/solana/tests/usdc_escrow_*.ts` green on localnet |
| G2.2 | Backend credits only finalized, exact, bound deposits, once | Fake-chain tests (extend `test/support/fake-chain.ts`) for every row of ESCROW_STATE_MACHINE §7 |
| G2.3 | The amount paid equals the issued invoice total; issued invoices are immutable | DB trigger test; API test |
| G2.4 | Auto-activation is exactly-once and doesn't need a browser | Integration test: deposit → kill the API → restart → exactly one `QUEUED` and one execution |
| G2.5 | Operator key in KMS/HSM (production); arbiter is a multisig; upgrade authority is a time-locked multisig | Key-custody record + on-chain account inspection script |
| G2.6 | Mainnet configuration is isolated: separate program id, mint, RPC and keys; the devnet code path can't select mainnet without an explicit flag set at deploy | Config tests (extend `assertDevnetNetworkPolicy`) |
| G2.7 | **Independent external audit** of `athernull_usdc_escrow` with all high and critical findings fixed | Audit report in `docs/security/audits/` |
| G2.8 | Reconciler alerting is live (funded-not-queued, chain/DB divergence, stray tokens) | Alert test fires in staging |

## G3: Delivery and settlement policy (Phases 6–7). **Blocks S2.**

| # | Gate | Evidence |
|---|---|---|
| G3.1 | Before acceptance the customer gets a preview only; the full artifact unlocks at release | API test on `/patch` and repository download per state |
| G3.2 | The customer can't refund after delivery; the platform can't release before delivery or inside the review window | Anchor tests (G2.1) + API tests |
| G3.3 | The escrow agreement is written, reviewed by counsel, and shown at invoice time (the customer accepts its version) | `invoice.terms_version` stored; terms document in the repository |
| G3.4 | Build directories are isolated per build (Phase 6) or the residual risk is documented and accepted | Test or signed risk acceptance |

## Residual risks accepted for S1 (devnet, judges)

- Free work via the live sandbox during a build (a customer watching files in their own sandbox). The money is devnet only. Fix: G3.1 / G3.4.
- Single-host deployment: a host compromise affects every tenant. Documented; S2 needs a reviewed topology.
