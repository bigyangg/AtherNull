# contracts/solana

Optional escrow program (spec §8, §11). Not started — Phase 5.

Scope decision from the spec: Solana devnet is the initial proposed settlement demo target. No
Meteora/token launch or Zcash integration is part of this architecture baseline. Current contract
code, audits and actual fund custody arrangements must be validated before any real assets touch
this program.

## Phase 4E.1 — ProjectFunding (additive)

`ProjectFunding` (PDA `["pf", binding_hash]`) with `initialize_project_funding` (authority-signed) and `deposit_project_funding` (bound-customer-signed) was added alongside the legacy escrow instructions, which are untouched until Phase 4E.2. See docs/adr/0013-solana-devnet-project-funding.md. Local checks: `cargo test --lib` (binding vectors, deposit arithmetic) and `tests/project_funding.ts` against `solana-test-validator`.
