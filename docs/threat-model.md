# Threat model (skeleton)

Status: skeleton — fill in as each phase lands, not all at once.

## Assets

- Client source code and repository credentials
- Client tasks, artifacts, conversation/checkpoint state
- Budget/ledger state and escrow funds
- Platform credentials (LLM API keys, Coolify/host access, signing keys)

## Trust boundaries

- Browser ↔ Web/API (authenticated, tenant-scoped)
- API ↔ Orchestrator/queue (internal, still tenant-qualified)
- Orchestrator ↔ OpenHands worker (worker gets short-lived, task-scoped credentials only)
- Worker ↔ execution sandbox (sandbox gets no host SSH, no Docker socket, no prod DB creds, no
  escrow signing keys — non-negotiable, spec §1)
- Execution sandbox ↔ network (default-deny outbound; allowlisted registries/APIs only)
- Verifier ↔ worker (verifier runs on a clean copy, never trusts the worker's own success claim)
- Settlement service ↔ everything else (only path that can move funds; requires explicit
  authorization, never triggered by agent action alone)

## Non-negotiable rules (spec §1 — carried here verbatim, don't relitigate per-phase)

- An agent never receives the host SSH account, Docker socket, production database credentials or
  escrow signing keys.
- PostgreSQL is the authoritative record; Redis is a queue/cache, never the money ledger.
- A worker reports a result; it cannot approve its own result or release funds.
- One client cannot access another client's code, context, secrets, tasks or artifacts.
- No deployment or payment action is considered successful until the authoritative system confirms
  it.

## Open risks tracked from spec §8

| Risk | Guardrail | Status |
|---|---|---|
| Repeated queue delivery | Unique execution lease + idempotency keys | Not implemented (Phase 1) |
| Token runaway | Gateway cap, sandbox shutdown, spend reservation | Not implemented (Phase 3) |
| Fabricated success log | Clean independent verifier + artifact hash | Not implemented (Phase 4) |
| Double settlement | Single settlement intent + chain confirmation reconciliation | Not implemented (Phase 5) |
| Tenant data leakage | Server-side access checks, isolated artifacts/workspaces | Not implemented (Phase 1/3) |
| Disputed result | Evidence retention, defined review owner, payout hold, refund rules | Not implemented (Phase 4/5) |

Update this table's Status column as each phase closes — don't let it go stale.
