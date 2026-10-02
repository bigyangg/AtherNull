use anchor_lang::prelude::*;

/// PDA seed prefix: `[ESCROW_SEED, task_id]` (plansol.md Sec 1).
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";

/// PDA seed prefix for `ProjectFunding`: `[PROJECT_FUNDING_SEED, binding_hash]`
/// (ADR-0013). The 32-byte binding hash is exactly Solana's per-seed limit.
#[constant]
pub const PROJECT_FUNDING_SEED: &[u8] = b"pf";

/// Domain separator for the canonical provenance binding hash (ADR-0013).
pub const BINDING_DOMAIN: &[u8] = b"athernull:project-funding:v1";
/// Binding-hash format version byte, hashed right after `BINDING_DOMAIN`.
pub const BINDING_VERSION: u8 = 0x01;
/// Current `ProjectFunding.version`.
pub const PROJECT_FUNDING_VERSION: u8 = 1;
